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
