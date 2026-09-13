package interceptor_test

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/interceptor"
)

// ─── Hashed Matcher Unit Tests (T002 / T003) ──────────────────────────────────

func TestRequestKeyDeterministic(t *testing.T) {
	key1 := interceptor.RequestKey("GET", "https://api.example.com/v1/chat", []byte(`{"model":"gpt-4"}`))
	key2 := interceptor.RequestKey("GET", "https://api.example.com/v1/chat", []byte(`{"model":"gpt-4"}`))
	if key1 != key2 {
		t.Fatalf("RequestKey is not deterministic: %s != %s", key1, key2)
	}
}

func TestRequestKeyMethodNormalization(t *testing.T) {
	keyLower := interceptor.RequestKey("post", "https://api.example.com/v1/chat", nil)
	keyUpper := interceptor.RequestKey("POST", "https://api.example.com/v1/chat", nil)
	if keyLower != keyUpper {
		t.Fatalf("RequestKey should normalize method case: %s != %s", keyLower, keyUpper)
	}
}

func TestRequestKeyEmptyBody(t *testing.T) {
	keyNil := interceptor.RequestKey("GET", "https://example.com/", nil)
	keyEmpty := interceptor.RequestKey("GET", "https://example.com/", []byte{})
	if keyNil != keyEmpty {
		t.Fatalf("nil and empty body should produce same key: %s != %s", keyNil, keyEmpty)
	}
}

func TestRequestKeyDifferentBodies(t *testing.T) {
	key1 := interceptor.RequestKey("POST", "https://example.com/api", []byte(`{"a":1}`))
	key2 := interceptor.RequestKey("POST", "https://example.com/api", []byte(`{"a":2}`))
	if key1 == key2 {
		t.Fatal("Different bodies should produce different keys")
	}
}

func TestRequestKeyURLNormalization(t *testing.T) {
	// URL with ignored query params should produce same key
	key1 := interceptor.NormalizeURLForKey("https://api.example.com/v1?key=abc&timestamp=1234", []string{"timestamp"})
	key2 := interceptor.NormalizeURLForKey("https://api.example.com/v1?key=abc&timestamp=9999", []string{"timestamp"})
	if key1 != key2 {
		t.Fatalf("Ignored query params should not affect normalized URL: %s != %s", key1, key2)
	}
}

func TestRequestKeyURLQuerySortedDeterministic(t *testing.T) {
	// Same params different order should produce same normalized URL
	url1 := interceptor.NormalizeURLForKey("https://api.example.com/v1?b=2&a=1", nil)
	url2 := interceptor.NormalizeURLForKey("https://api.example.com/v1?a=1&b=2", nil)
	if url1 != url2 {
		t.Fatalf("Query param order should not matter: %s != %s", url1, url2)
	}
}

func TestRequestKeyLargeBody(t *testing.T) {
	// 1MB body
	largeBody := make([]byte, 1024*1024)
	rand.Read(largeBody) //nolint:errcheck
	key1 := interceptor.RequestKey("POST", "https://example.com/upload", largeBody)
	key2 := interceptor.RequestKey("POST", "https://example.com/upload", largeBody)
	if key1 != key2 {
		t.Fatal("Large body key should be deterministic")
	}
}

// ─── Hashed Index O(1) Lookup Tests ──────────────────────────────────────────

func makeTestRun(steps int) *core.Run {
	run := &core.Run{RunID: "test-run-001", Steps: make([]core.Step, steps)}
	for i := range run.Steps {
		run.Steps[i] = core.Step{
			Type: core.StepTypeHTTP,
			Request: &core.HTTPRequest{
				Method: "POST",
				URL:    fmt.Sprintf("https://api.example.com/step/%d", i),
				Body:   []byte(fmt.Sprintf(`{"step":%d}`, i)),
			},
			Response: &core.HTTPResponse{
				Status:     "200 OK",
				StatusCode: 200,
				Headers:    http.Header{"Content-Type": []string{"application/json"}},
				Body:       []byte(fmt.Sprintf(`{"result":%d}`, i)),
			},
		}
	}
	return run
}

func TestHashedMatcherReplayHit(t *testing.T) {
	run := makeTestRun(10)
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)

	// Request that matches step 5
	step5 := run.Steps[5].Request
	req, _ := http.NewRequest(step5.Method, step5.URL, bytes.NewReader(step5.Body))

	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("Expected cache hit, got error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}
}

func TestHashedMatcherReplayMiss(t *testing.T) {
	run := makeTestRun(5)
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)

	req, _ := http.NewRequest("POST", "https://api.example.com/NOT_RECORDED", bytes.NewReader([]byte(`{"x":99}`)))
	_, err := inter.RoundTrip(req)
	if err == nil {
		t.Fatal("Expected error for cache miss (no fallback), got nil")
	}
	if !strings.Contains(err.Error(), "no matching recorded step") {
		t.Fatalf("Unexpected error message: %v", err)
	}
}

func TestHashedMatcherDuplicateRequests(t *testing.T) {
	// Same request recorded twice — should match first, then second
	run := &core.Run{RunID: "dup-run", Steps: []core.Step{
		{
			Type:     core.StepTypeHTTP,
			Request:  &core.HTTPRequest{Method: "GET", URL: "https://api.example.com/ping", Body: nil},
			Response: &core.HTTPResponse{Status: "200 OK", StatusCode: 200, Body: []byte("pong-1")},
		},
		{
			Type:     core.StepTypeHTTP,
			Request:  &core.HTTPRequest{Method: "GET", URL: "https://api.example.com/ping", Body: nil},
			Response: &core.HTTPResponse{Status: "200 OK", StatusCode: 200, Body: []byte("pong-2")},
		},
	}}

	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)

	req1, _ := http.NewRequest("GET", "https://api.example.com/ping", nil)
	resp1, err := inter.RoundTrip(req1)
	if err != nil {
		t.Fatalf("First request failed: %v", err)
	}
	body1, _ := io.ReadAll(resp1.Body)

	req2, _ := http.NewRequest("GET", "https://api.example.com/ping", nil)
	resp2, err := inter.RoundTrip(req2)
	if err != nil {
		t.Fatalf("Second request failed: %v", err)
	}
	body2, _ := io.ReadAll(resp2.Body)

	if string(body1) == string(body2) {
		t.Fatal("Duplicate requests should return different (FIFO) recorded responses")
	}
}

// ─── Record Mode Tests ────────────────────────────────────────────────────────

func TestRecordCapturesStep(t *testing.T) {
	// Set up a test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
	}))
	defer server.Close()

	run := &core.Run{RunID: "rec-001", Steps: []core.Step{}}
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeRecord, nil, run)

	req, _ := http.NewRequest("POST", server.URL+"/api", bytes.NewReader([]byte(`{"test":1}`)))
	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	resp.Body.Close()

	if len(run.Steps) != 1 {
		t.Fatalf("Expected 1 recorded step, got %d", len(run.Steps))
	}
	step := run.Steps[0]
	if step.Response.RequestKey == "" {
		t.Fatal("RequestKey should be set on recorded step")
	}
}

// ─── Streaming Round-Trip Tests (T014) ────────────────────────────────────────

func TestStreamingResponsePreserved(t *testing.T) {
	// Server that returns chunked/SSE response
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("ResponseWriter doesn't support flushing")
			return
		}
		for i := 0; i < 5; i++ {
			fmt.Fprintf(w, "data: chunk-%d\n\n", i)
			flusher.Flush()
			time.Sleep(5 * time.Millisecond)
		}
	}))
	defer server.Close()

	run := &core.Run{RunID: "stream-001", Steps: []core.Step{}}
	recInter := interceptor.NewHTTPInterceptor(interceptor.ModeRecord, nil, run)

	req, _ := http.NewRequest("GET", server.URL+"/stream", nil)
	resp, err := recInter.RoundTrip(req)
	if err != nil {
		t.Fatalf("Record streaming failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if len(run.Steps) != 1 {
		t.Fatalf("Expected 1 step, got %d", len(run.Steps))
	}

	step := run.Steps[0]
	if !strings.Contains(string(body), "chunk-") {
		t.Fatalf("Expected streaming body chunks, got: %s", string(body))
	}

	// StreamingPreserved may be true if we got multiple chunks
	t.Logf("StreamingPreserved: %v, Chunks: %d, Body len: %d",
		step.Response.StreamingPreserved, len(step.Response.Chunks), len(step.Response.Body))
}

func TestStreamingPreservedFlagInAnnotation(t *testing.T) {
	run := &core.Run{RunID: "ann-001", Steps: []core.Step{
		{
			Type: core.StepTypeHTTP,
			Request: &core.HTTPRequest{
				Method: "GET",
				URL:    "https://api.example.com/stream",
				Body:   nil,
			},
			Response: &core.HTTPResponse{
				Status:             "200 OK",
				StatusCode:         200,
				Body:               []byte("data: chunk-0\n\ndata: chunk-1\n\n"),
				Chunks:             [][]byte{[]byte("data: chunk-0\n\n"), []byte("data: chunk-1\n\n")},
				StreamingPreserved: true,
			},
		},
	}}

	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)
	req, _ := http.NewRequest("GET", "https://api.example.com/stream", nil)
	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("Replay streaming failed: %v", err)
	}

	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if !strings.Contains(string(body), "chunk-") {
		t.Fatalf("Expected streamed chunks in body, got: %s", string(body))
	}

	// Annotation log should have streamingPreserved: true
	logData := inter.WriteAnnotationLog()
	if !strings.Contains(string(logData), `"streamingPreserved":true`) {
		t.Fatalf("Annotation log missing streamingPreserved=true: %s", string(logData))
	}
}

func TestRewriteRequestBodyPrompt_Messages(t *testing.T) {
	origJSON := `{"messages":[{"role":"user","content":"Provide a concise 2-sentence summary."}],"model":"openrouter/free"}`
	rewritten, ok := interceptor.RewriteRequestBodyPrompt([]byte(origJSON), "Provide a concise 2-sentence summary.", "Provide a concise 3-sentence summary.")
	if !ok {
		t.Fatalf("Expected rewrite to succeed")
	}

	var parsed map[string]any
	if err := json.Unmarshal(rewritten, &parsed); err != nil {
		t.Fatalf("Failed to parse rewritten JSON: %v", err)
	}
	msgs := parsed["messages"].([]any)
	firstMsg := msgs[0].(map[string]any)
	if firstMsg["content"] != "Provide a concise 3-sentence summary." {
		t.Fatalf("Expected content 'Provide a concise 3-sentence summary.', got: %v", firstMsg["content"])
	}
}

func TestRewriteRequestBodyPrompt_StripRolePrefix(t *testing.T) {
	origJSON := `{"messages":[{"role":"user","content":"Synthesize findings into briefing"}],"model":"openrouter/free"}`
	rewritten, ok := interceptor.RewriteRequestBodyPrompt([]byte(origJSON), "human: Synthesize findings into briefing", "human: Detailed 5-page report")
	if !ok {
		t.Fatalf("Expected rewrite to succeed")
	}

	var parsed map[string]any
	if err := json.Unmarshal(rewritten, &parsed); err != nil {
		t.Fatalf("Failed to parse rewritten JSON: %v", err)
	}
	msgs := parsed["messages"].([]any)
	firstMsg := msgs[0].(map[string]any)
	if firstMsg["content"] != "Detailed 5-page report" {
		t.Fatalf("Expected 'Detailed 5-page report' with role stripped, got: %v", firstMsg["content"])
	}
}

func TestReplayPromptOverrideExecution(t *testing.T) {
	// A mock round tripper to capture outbound request
	var capturedReqBody []byte
	mockTransport := &mockRoundTripper{
		roundTripFunc: func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			capturedReqBody = b
			return &http.Response{
				StatusCode: 200,
				Status:     "200 OK",
				Body:       io.NopCloser(bytes.NewBufferString(`{"choices":[{"message":{"content":"Here is the 3-sentence summary."}}]}`)),
				Header:     make(http.Header),
			}, nil
		},
	}

	run := &core.Run{RunID: "ovr-001", Steps: []core.Step{}}
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)
	inter.Transport = mockTransport
	inter.Fallback = true
	inter.OverrideConfig = &interceptor.OverrideConfig{
		ForkFromSpanId:     "s_synth",
		OriginalPromptText: "Provide a concise 2-sentence summary.",
		PromptText:         "Provide a concise 3-sentence summary.",
	}

	reqBody := `{"messages":[{"role":"user","content":"Provide a concise 2-sentence summary."}],"model":"openrouter/free"}`
	req, _ := http.NewRequest("POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewBufferString(reqBody))
	req.Header.Set("X-AeroGraph-Span-Id", "s_synth")

	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip failed: %v", err)
	}
	resp.Body.Close()

	// Verify that the captured request body sent to the transport had the rewritten prompt
	if !strings.Contains(string(capturedReqBody), "Provide a concise 3-sentence summary.") {
		t.Fatalf("Expected outbound body to contain rewritten prompt, got: %s", string(capturedReqBody))
	}

	// Verify that the annotation log marked the span as overridden
	logData := inter.WriteAnnotationLog()
	if !strings.Contains(string(logData), `"overridden":true`) {
		t.Fatalf("Annotation log missing overridden=true: %s", string(logData))
	}
}

type mockRoundTripper struct {
	roundTripFunc func(*http.Request) (*http.Response, error)
}

func (m *mockRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return m.roundTripFunc(r)
}


// ─── Benchmark: p95 lookup latency (T005) ────────────────────────────────────

// BenchmarkHashedMatcherLookup200 benchmarks O(1) lookup at 200 steps.
func BenchmarkHashedMatcherLookup200(b *testing.B) {
	benchmarkLookup(b, 200)
}

// BenchmarkHashedMatcherLookup500 benchmarks at 500 steps.
func BenchmarkHashedMatcherLookup500(b *testing.B) {
	benchmarkLookup(b, 500)
}

// BenchmarkHashedMatcherLookup1000 benchmarks at 1000 steps.
func BenchmarkHashedMatcherLookup1000(b *testing.B) {
	benchmarkLookup(b, 1000)
}

func benchmarkLookup(b *testing.B, stepCount int) {
	b.Helper()
	run := makeTestRun(stepCount)
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)

	// Pre-warm index by doing one lookup
	firstStep := run.Steps[0].Request
	warmReq, _ := http.NewRequest(firstStep.Method, firstStep.URL, bytes.NewReader(firstStep.Body))
	inter.RoundTrip(warmReq) //nolint:errcheck

	// Build fresh interceptor for benchmarking (avoid used-step pollution)
	run2 := makeTestRun(stepCount)
	inter2 := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run2)

	// Pick the last step as the target (worst case for linear scan, same for hash)
	targetStep := run2.Steps[stepCount-1].Request

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		// Build new run each time so we don't exhaust usedSteps
		r := makeTestRun(stepCount)
		in := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, r)
		_ = in // force index build on first RoundTrip

		req, _ := http.NewRequest(targetStep.Method, targetStep.URL, bytes.NewReader(targetStep.Body))
		_, err := in.RoundTrip(req)
		if err != nil {
			b.Fatalf("Lookup failed: %v", err)
		}
	}

	b.StopTimer()
	_ = inter2
}

// ─── Tests for Audit Hardening Fixes ──────────────────────────────────────────

func TestChunkedReplayReader_DiscreteChunkBoundaries(t *testing.T) {
	chunks := [][]byte{
		[]byte("event: message\ndata: hello\n\n"),
		[]byte("event: message\ndata: world\n\n"),
		[]byte("event: done\ndata: [DONE]\n\n"),
	}

	reader := interceptor.NewChunkedReplayReader(chunks, nil, false)
	defer reader.Close()

	// Read buffer is deliberately larger than all chunks combined (1024 bytes)
	buf := make([]byte, 1024)

	// Call 1: Must return ONLY chunk 1, not all chunks concatenated
	n1, err := reader.Read(buf)
	if err != nil {
		t.Fatalf("First read failed: %v", err)
	}
	if string(buf[:n1]) != string(chunks[0]) {
		t.Fatalf("Expected chunk 0 '%s', got '%s'", string(chunks[0]), string(buf[:n1]))
	}

	// Call 2: Must return chunk 2
	n2, err := reader.Read(buf)
	if err != nil {
		t.Fatalf("Second read failed: %v", err)
	}
	if string(buf[:n2]) != string(chunks[1]) {
		t.Fatalf("Expected chunk 1 '%s', got '%s'", string(chunks[1]), string(buf[:n2]))
	}

	// Call 3: Must return chunk 3
	n3, err := reader.Read(buf)
	if err != nil {
		t.Fatalf("Third read failed: %v", err)
	}
	if string(buf[:n3]) != string(chunks[2]) {
		t.Fatalf("Expected chunk 2 '%s', got '%s'", string(chunks[2]), string(buf[:n3]))
	}

	// Call 4: Must return EOF
	n4, err := reader.Read(buf)
	if err != io.EOF || n4 != 0 {
		t.Fatalf("Expected EOF and 0 bytes, got err=%v, n=%d", err, n4)
	}
}

func TestChunkedReplayReader_RealtimePlaybackTiming(t *testing.T) {
	chunks := [][]byte{
		[]byte("chunk-0"),
		[]byte("chunk-1"),
		[]byte("chunk-2"),
	}
	delays := []int64{30, 20, 20} // delays[0] = 30ms is TTFT!

	// 1. Without realtime playback (default): must be instantaneous (< 15ms)
	startFast := time.Now()
	fastReader := interceptor.NewChunkedReplayReader(chunks, delays, false)
	_, _ = io.ReadAll(fastReader)
	fastDuration := time.Since(startFast)
	if fastDuration > 20*time.Millisecond {
		t.Fatalf("Default replay without realtime-playback took unexpectedly long: %v", fastDuration)
	}

	// 2. With realtime playback enabled: reading chunk 0 alone MUST sleep for TTFT (delays[0] >= 30ms)
	realtimeReader := interceptor.NewChunkedReplayReader(chunks, delays, true)
	firstBuf := make([]byte, 1024)
	startChunk0 := time.Now()
	n0, err := realtimeReader.Read(firstBuf)
	chunk0Duration := time.Since(startChunk0)
	if err != nil || n0 == 0 {
		t.Fatalf("Failed to read first chunk: %v", err)
	}
	if chunk0Duration < 25*time.Millisecond {
		t.Fatalf("Expected first chunk (TTFT) to sleep for delays[0] >= 30ms, but took %v", chunk0Duration)
	}

	// Read remaining chunks and verify total elapsed time reflects full sequence >= 70ms
	_, _ = io.ReadAll(realtimeReader)
	totalDuration := time.Since(startChunk0)
	if totalDuration < 60*time.Millisecond {
		t.Fatalf("Expected total replay duration >= 60ms, got: %v", totalDuration)
	}
}

func TestSecretRedaction_HeadersAndQueryParams(t *testing.T) {
	var receivedAuthHeader string
	var receivedAPIKeyHeader string
	var receivedQueryKey string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuthHeader = r.Header.Get("Authorization")
		receivedAPIKeyHeader = r.Header.Get("X-Api-Key")
		receivedQueryKey = r.URL.Query().Get("key")
		w.Header().Set("Set-Cookie", "session=super-secret-auth-cookie")
		w.Header().Set("Server", "test-server")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	}))
	defer server.Close()

	run := &core.Run{RunID: "redact-001", Steps: []core.Step{}}
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeRecord, nil, run)

	// Send request with sensitive secrets
	reqURL := fmt.Sprintf("%s/v1/chat?key=AIzaSySecretApiKey123&user=test", server.URL)
	req, _ := http.NewRequest("POST", reqURL, bytes.NewReader([]byte(`{"hello":1}`)))
	req.Header.Set("Authorization", "Bearer sk-live-secret-token")
	req.Header.Set("X-Api-Key", "sk-custom-secret-key")
	req.Header.Set("Date", "Mon, 02 Jan 2006 15:04:05 MST")

	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("Record call failed: %v", err)
	}
	resp.Body.Close()

	// 1. Verify outbound request to upstream server had the REAL unredacted values
	if receivedAuthHeader != "Bearer sk-live-secret-token" {
		t.Fatalf("Upstream server did not receive original auth header: %s", receivedAuthHeader)
	}
	if receivedAPIKeyHeader != "sk-custom-secret-key" {
		t.Fatalf("Upstream server did not receive original X-Api-Key: %s", receivedAPIKeyHeader)
	}
	if receivedQueryKey != "AIzaSySecretApiKey123" {
		t.Fatalf("Upstream server did not receive original query key: %s", receivedQueryKey)
	}

	// 2. Verify stored cassette step was REDACTED on BOTH request and response
	if len(run.Steps) != 1 {
		t.Fatalf("Expected 1 step recorded, got %d", len(run.Steps))
	}
	step := run.Steps[0]

	// Request headers in cassette must be redacted or removed
	if step.Request.Headers.Get("Authorization") != "[REDACTED]" {
		t.Fatalf("Cassette Authorization header was not redacted: %v", step.Request.Headers.Get("Authorization"))
	}
	if step.Request.Headers.Get("X-Api-Key") != "[REDACTED]" {
		t.Fatalf("Cassette X-Api-Key header was not redacted: %v", step.Request.Headers.Get("X-Api-Key"))
	}
	if step.Request.Headers.Get("Date") != "" {
		t.Fatalf("Cassette should omit ignored Date header, got: %v", step.Request.Headers.Get("Date"))
	}

	// Response headers in cassette must also be redacted (Set-Cookie)
	if step.Response.Headers.Get("Set-Cookie") != "[REDACTED]" {
		t.Fatalf("Cassette response Set-Cookie header was not redacted: %v", step.Response.Headers.Get("Set-Cookie"))
	}

	// URL in cassette must have query secret redacted
	if strings.Contains(step.Request.URL, "AIzaSySecretApiKey123") {
		t.Fatalf("Cassette step stored raw API key in URL: %s", step.Request.URL)
	}
	if !strings.Contains(step.Request.URL, "key=%5BREDACTED%5D") && !strings.Contains(step.Request.URL, "key=[REDACTED]") {
		t.Fatalf("Cassette step URL missing [REDACTED] query param: %s", step.Request.URL)
	}
}

func TestReplayLiveBranches_PersistSteps(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"live_result":"fresh"}`)) //nolint:errcheck
	}))
	defer server.Close()

	// Initial run has only 1 step
	run := &core.Run{RunID: "fork-run-001", Steps: []core.Step{
		{
			Type: core.StepTypeHTTP,
			Request: &core.HTTPRequest{
				Method: "GET",
				URL:    server.URL + "/cached",
				Body:   nil,
			},
			Response: &core.HTTPResponse{
				Status:     "200 OK",
				StatusCode: 200,
				Body:       []byte(`{"cached":true}`),
			},
		},
	}}

	inter := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)
	inter.Fallback = true

	// 1. Request that hits cache: should NOT append new step
	reqCached, _ := http.NewRequest("GET", server.URL+"/cached", nil)
	respCached, err := inter.RoundTrip(reqCached)
	if err != nil {
		t.Fatalf("Cached request failed: %v", err)
	}
	respCached.Body.Close()

	if len(run.Steps) != 1 {
		t.Fatalf("Cache hit should not append step, expected 1, got %d", len(run.Steps))
	}

	// 2. Request that misses cache and falls back to live network: MUST append new step!
	reqMiss, _ := http.NewRequest("POST", server.URL+"/new-live-call", bytes.NewReader([]byte(`{"q":2}`)))
	respMiss, err := inter.RoundTrip(reqMiss)
	if err != nil {
		t.Fatalf("Fallback request failed: %v", err)
	}
	body, _ := io.ReadAll(respMiss.Body)
	respMiss.Body.Close()

	if string(body) != `{"live_result":"fresh"}` {
		t.Fatalf("Expected live response body, got: %s", string(body))
	}

	// Crucial check: Step must be appended to run.Steps so the fork has its own complete cassette!
	if len(run.Steps) != 2 {
		t.Fatalf("Critical 3 regression: Live fallback step was NOT appended to run.Steps! Got %d steps", len(run.Steps))
	}
	liveStep := run.Steps[1]
	if liveStep.Request.URL != server.URL+"/new-live-call" {
		t.Fatalf("Appended step has wrong URL: %s", liveStep.Request.URL)
	}
}

func TestStrictOverrideMatching_NoAccidentalHijack(t *testing.T) {
	run := &core.Run{RunID: "strict-ovr", Steps: []core.Step{}}
	inter := interceptor.NewHTTPInterceptor(interceptor.ModeRecord, nil, run)
	inter.OverrideConfig = &interceptor.OverrideConfig{
		ForkFromSpanId:     "target_span_15",
		OriginalPromptText: "Original prompt for step 15",
		PromptText:         "Rewritten prompt for step 15",
	}

	// An unrelated completions request at step 1 with span ID "span_1" and different prompt
	reqBody := `{"messages":[{"role":"user","content":"Initial prompt for step 1"}],"model":"openrouter/free"}`
	req, _ := http.NewRequest("POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewBufferString(reqBody))
	req.Header.Set("X-AeroGraph-Span-Id", "span_1")

	// Verify RewriteRequestBodyPrompt is not triggered
	mockTransport := &mockRoundTripper{
		roundTripFunc: func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			if strings.Contains(string(b), "Rewritten prompt for step 15") {
				t.Fatalf("Step 1 completions request was incorrectly hijacked by step 15 override!")
			}
			return &http.Response{
				StatusCode: 200,
				Status:     "200 OK",
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":"ok"}`)),
				Header:     make(http.Header),
			}, nil
		},
	}
	inter.Transport = mockTransport

	resp, err := inter.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip failed: %v", err)
	}
	resp.Body.Close()
}

