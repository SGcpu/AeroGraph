package interceptor

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/storage"
)

// ANSI Color codes
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorCyan   = "\033[36m"
)

// Mode defines the operation mode for the interceptor.
type Mode int

const (
	ModeRecord Mode = iota
	ModeReplay
	ModePassthrough
)

// AnnotationEntry is emitted to the annotation log for each intercepted request.
// It is consumed by the AeroGraph Orchestrator to produce span annotations.
type AnnotationEntry struct {
	RequestKey         string  `json:"requestKey"`
	CorrelatedSpanId   string  `json:"correlatedSpanId,omitempty"`
	ReplaySource       string  `json:"replaySource"` // "cache" | "live"
	ReplayLatencyMs    float64 `json:"replayLatencyMs,omitempty"`
	StreamingPreserved bool    `json:"streamingPreserved"`
	Decision           string  `json:"decision"` // "cache_hit" | "cache_miss_error" | "must_execute" | "fallback" | "live_record"
	MatchedPattern     string  `json:"matchedPattern,omitempty"`
	EffectiveClass     string  `json:"effectiveClass,omitempty"` // "replay_safe" | "must_execute"
	Overridden         bool    `json:"overridden,omitempty"`
}

// OverrideConfig represents prompt/span substitutions supplied via --override-file.
type OverrideConfig struct {
	ForkFromSpanId     string            `json:"forkFromSpanId,omitempty"`
	PromptText         string            `json:"promptText,omitempty"`
	OriginalPromptText string            `json:"originalPromptText,omitempty"`
	Overrides          map[string]string `json:"overrides,omitempty"`
}

// RequestKey computes K(s) = SHA256(method ‖ normalizedUrl ‖ SHA256(body))
// This is the canonical deterministic request key per spec FR-009.
func RequestKey(method, normalizedURL string, body []byte) string {
	// SHA256 of body first (empty body → SHA256 of empty bytes, not empty string SHA256)
	bodyHash := sha256.Sum256(body)
	bodyHashHex := hex.EncodeToString(bodyHash[:])

	// Normalize method to uppercase
	m := strings.ToUpper(strings.TrimSpace(method))

	// Concatenate: method + "\n" + normalizedUrl + "\n" + bodyHashHex
	combined := m + "\n" + normalizedURL + "\n" + bodyHashHex
	h := sha256.Sum256([]byte(combined))
	return hex.EncodeToString(h[:])
}

// cassetteIndex is the O(1) hash map index built from a cassette (Steps slice).
// It maps requestKey → list of step indices (to handle identical requests that appear
// more than once in a recording, e.g. retried requests).
type cassetteIndex struct {
	mu      sync.Mutex
	// key → ordered list of step indices that match, used FIFO
	buckets map[string][]int
	used    map[int]bool
}

func newCassetteIndex(steps []core.Step, normalizeURL func(string) string) *cassetteIndex {
	ci := &cassetteIndex{
		buckets: make(map[string][]int),
		used:    make(map[int]bool),
	}
	for idx, step := range steps {
		if step.Type != core.StepTypeHTTP || step.Request == nil {
			continue
		}
		key := RequestKey(step.Request.Method, normalizeURL(step.Request.URL), step.Request.Body)
		ci.buckets[key] = append(ci.buckets[key], idx)
	}
	return ci
}

// lookup returns the step index for the given key, or -1 if no unused match.
// Thread-safe; marks the returned index as used.
func (ci *cassetteIndex) lookup(key string) int {
	ci.mu.Lock()
	defer ci.mu.Unlock()
	indices, ok := ci.buckets[key]
	if !ok {
		return -1
	}
	for _, idx := range indices {
		if !ci.used[idx] {
			ci.used[idx] = true
			return idx
		}
	}
	return -1
}

// NewCassetteIndexExported exports newCassetteIndex for external benchmarks and tests.
func NewCassetteIndexExported(steps []core.Step) *cassetteIndex {
	return newCassetteIndex(steps, func(u string) string { return u })
}

// LookupWithoutMarking inspects the cassette index for a matching step index without consuming the FIFO entry.
// Useful for pre-flight cache probing and tests.
func (ci *cassetteIndex) LookupWithoutMarking(key string) int {
	ci.mu.Lock()
	defer ci.mu.Unlock()
	indices, ok := ci.buckets[key]
	if !ok || len(indices) == 0 {
		return -1
	}
	return indices[0]
}

// HTTPInterceptor is an http.RoundTripper that can intercept and record/replay HTTP requests.
// In replay mode it uses an O(1) SHA-256 hashed cassette index (not the upstream linear scan).
type HTTPInterceptor struct {
	Transport         http.RoundTripper
	Mode              Mode
	Storage           storage.Storage
	CurrentRun        *core.Run
	Fallback          bool // If true, call real network when no match is found
	RealtimePlayback  bool // If true, chunked replay reader reconstructs recorded chunk timings
	IgnoreHeaders     []string
	IgnoreQueryParams []string
	LiveHosts         []string // Host glob patterns that always go live (must_execute)
	AnnotationLog     []AnnotationEntry
	OverrideConfig    *OverrideConfig
	overrideApplied   bool
	// hashed index — populated on first replay RoundTrip from CurrentRun.Steps
	cassetteIdx      *cassetteIndex
	idxOnce          sync.Once
	NetworkCallCount int
	mu               sync.Mutex
}

// NewHTTPInterceptor creates a new HTTPInterceptor.
func NewHTTPInterceptor(mode Mode, s storage.Storage, currentRun *core.Run) *HTTPInterceptor {
	var transport http.RoundTripper = http.DefaultTransport
	if dt, ok := http.DefaultTransport.(*http.Transport); ok {
		cloned := dt.Clone()
		if cloned.Proxy != nil {
			origProxy := cloned.Proxy
			cloned.Proxy = func(req *http.Request) (*url.URL, error) {
				proxyURL, err := origProxy(req)
				if err != nil || proxyURL == nil {
					return nil, err
				}
				h := proxyURL.Hostname()
				if h == "localhost" || h == "127.0.0.1" || h == "::1" {
					return nil, nil // bypass loopback proxy for outbound requests
				}
				return proxyURL, nil
			}
		}
		transport = cloned
	}
	return &HTTPInterceptor{
		Transport:         transport,
		Mode:              mode,
		Storage:           s,
		CurrentRun:        currentRun,
		IgnoreHeaders:     []string{"User-Agent", "Date", "Authorization", "X-Amz-Date"},
		IgnoreQueryParams: []string{"timestamp", "nonce", "api_key"},
		AnnotationLog:     []AnnotationEntry{},
	}
}

// isSensitiveHeader returns true if the header name indicates auth or secret credentials.
func isSensitiveHeader(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch lower {
	case "authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "api-key", "openai-api-key", "anthropic-api-key", "set-cookie", "cookie":
		return true
	}
	return strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "auth") || strings.Contains(lower, "api-key") || strings.Contains(lower, "cookie")
}

// sanitizeHeaders redacts sensitive headers to "[REDACTED]" and removes ignored transient headers.
func sanitizeHeaders(headers http.Header, ignoreList []string) http.Header {
	if headers == nil {
		return nil
	}
	sanitized := headers.Clone()
	// 1. Redact sensitive headers
	for k := range sanitized {
		if isSensitiveHeader(k) {
			sanitized.Set(k, "[REDACTED]")
		}
	}
	// 2. Remove transient ignored headers
	for _, ign := range ignoreList {
		for k := range sanitized {
			if strings.EqualFold(k, ign) && !isSensitiveHeader(k) {
				sanitized.Del(k)
			}
		}
	}
	return sanitized
}

// isSensitiveQueryParam returns true if the query parameter key indicates auth/secrets.
func isSensitiveQueryParam(param string) bool {
	lower := strings.ToLower(strings.TrimSpace(param))
	switch lower {
	case "key", "api_key", "apikey", "token", "access_token", "auth", "secret", "signature", "sig":
		return true
	}
	return strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "key")
}

// sanitizeURL redacts sensitive query parameters (e.g. ?key=AIza...) for cassette storage.
func sanitizeURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	modified := false
	for k := range q {
		if isSensitiveQueryParam(k) {
			q.Set(k, "[REDACTED]")
			modified = true
		}
	}
	if modified {
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// recordingBody wraps an upstream body during live execution to stream chunks in real-time
// to the caller while simultaneously capturing chunks and timing for the cassette.
type recordingBody struct {
	underlying  io.ReadCloser
	fullBody    bytes.Buffer
	chunks      [][]byte
	chunkDelays []int64
	lastChunkAt time.Time
	isStreaming bool
	onSuccess   func(body []byte, chunks [][]byte, delays []int64)
	onError     func(err error)
	finishOnce  sync.Once
	hasCleanEOF bool
}

func newRecordingBody(
	underlying io.ReadCloser,
	startTime time.Time,
	isStreaming bool,
	onSuccess func(body []byte, chunks [][]byte, delays []int64),
	onError func(err error),
) *recordingBody {
	return &recordingBody{
		underlying:  underlying,
		lastChunkAt: startTime,
		isStreaming: isStreaming,
		onSuccess:   onSuccess,
		onError:     onError,
	}
}

func (r *recordingBody) Read(p []byte) (int, error) {
	n, err := r.underlying.Read(p)
	if n > 0 {
		now := time.Now()
		delayMs := now.Sub(r.lastChunkAt).Milliseconds()
		r.lastChunkAt = now

		chunk := make([]byte, n)
		copy(chunk, p[:n])
		r.chunks = append(r.chunks, chunk)
		r.chunkDelays = append(r.chunkDelays, delayMs)
		r.fullBody.Write(chunk)
	}

	if err == io.EOF {
		r.hasCleanEOF = true
		r.finish(nil)
	} else if err != nil {
		r.finish(err)
	}

	return n, err
}

func (r *recordingBody) finish(err error) {
	r.finishOnce.Do(func() {
		if r.hasCleanEOF && err == nil {
			if r.onSuccess != nil {
				r.onSuccess(r.fullBody.Bytes(), r.chunks, r.chunkDelays)
			}
		} else {
			if r.onError != nil {
				r.onError(err)
			}
		}
	})
}

func (r *recordingBody) Close() error {
	var closeErr error
	if r.underlying != nil {
		closeErr = r.underlying.Close()
	}
	// If closed without hitting clean io.EOF, treat as premature disconnect
	if !r.hasCleanEOF {
		r.finish(fmt.Errorf("stream closed prematurely before EOF"))
	}
	return closeErr
}

// RoundTrip implements the http.RoundTripper interface.
func (i *HTTPInterceptor) RoundTrip(req *http.Request) (*http.Response, error) {
	switch i.Mode {
	case ModeRecord:
		return i.recordRoundTrip(req)
	case ModeReplay:
		return i.replayRoundTrip(req)
	case ModePassthrough:
		fallthrough
	default:
		return i.Transport.RoundTrip(req)
	}
}

// isLiveHost returns true if the request host matches any must_execute live-host pattern.
func (i *HTTPInterceptor) isLiveHost(host string) bool {
	for _, pattern := range i.LiveHosts {
		if matchHostGlob(pattern, host) {
			return true
		}
	}
	return false
}

// matchHostGlob performs simple glob matching: "*" matches any single segment,
// "**" matches any number of segments. Only "*" prefix globs are supported for now.
func matchHostGlob(pattern, host string) bool {
	if pattern == "*" {
		return true
	}
	// Simple prefix-wildcard: *.example.com matches foo.example.com
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		return strings.HasSuffix(host, suffix) || host == pattern[2:]
	}
	return pattern == host
}

// executeAndRecordLive executes an outbound live HTTP request, streaming chunks through to
// the caller in real-time, while capturing, sanitizing, and persisting the step to the cassette.
func (i *HTTPInterceptor) executeAndRecordLive(
	req *http.Request,
	reqBodyBytes []byte,
	normalizedURL string,
	correlatedSpanId string,
	decision string,
	effectiveClass string,
	isOverridden bool,
) (*http.Response, error) {
	startTime := time.Now()

	resp, err := i.Transport.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	i.mu.Lock()
	i.NetworkCallCount++
	i.mu.Unlock()

	reqKey := RequestKey(req.Method, normalizedURL, reqBodyBytes)

	contentType := resp.Header.Get("Content-Type")
	isSSE := strings.Contains(contentType, "text/event-stream")
	isChunked := false
	for _, te := range resp.TransferEncoding {
		if strings.ToLower(te) == "chunked" {
			isChunked = true
			break
		}
	}
	isStreaming := isSSE || isChunked

	onSuccess := func(respBody []byte, chunks [][]byte, chunkDelays []int64) {
		latencyMs := float64(time.Since(startTime).Microseconds()) / 1000.0
		streamingPreserved := isStreaming && len(chunks) > 1

		httpStep := core.Step{
			Type: core.StepTypeHTTP,
			Request: &core.HTTPRequest{
				Method:  req.Method,
				URL:     sanitizeURL(req.URL.String()),
				Headers: sanitizeHeaders(req.Header, i.IgnoreHeaders),
				Body:    reqBodyBytes,
			},
			Response: &core.HTTPResponse{
				Status:             resp.Status,
				StatusCode:         resp.StatusCode,
				Headers:            sanitizeHeaders(resp.Header, i.IgnoreHeaders),
				Body:               respBody,
				Chunks:             chunks,
				ChunkDelaysMs:      chunkDelays,
				StreamingPreserved: streamingPreserved,
				RequestKey:         reqKey,
				CorrelatedSpanId:   correlatedSpanId,
				RecordedAt:         time.Now().UTC().Format(time.RFC3339Nano),
				RecordLatencyMs:    latencyMs,
			},
		}

		i.mu.Lock()
		defer i.mu.Unlock()

		if i.CurrentRun != nil {
			i.CurrentRun.Steps = append(i.CurrentRun.Steps, httpStep)
			if i.Storage != nil {
				i.Storage.AppendStep(i.CurrentRun.RunID, httpStep)
			}
		}

		i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
			RequestKey:         reqKey,
			CorrelatedSpanId:   correlatedSpanId,
			ReplaySource:       "live",
			ReplayLatencyMs:    latencyMs,
			StreamingPreserved: streamingPreserved,
			Decision:           decision,
			EffectiveClass:     effectiveClass,
			Overridden:         isOverridden,
		})
	}

	onError := func(err error) {
		fmt.Printf("%s[INTERCEPTOR] Warning: Discarded incomplete step for %s %s due to error: %v%s\n",
			colorYellow, req.Method, req.URL.String(), err, colorReset)
	}

	if !isStreaming {
		var respBody []byte
		if resp.Body != nil {
			var readErr error
			respBody, readErr = io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil {
				return nil, readErr
			}
		}

		// If upstream returned gzip, decompress it so cassette and downstream client get clean plain UTF-8 JSON
		if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") && len(respBody) > 0 {
			if gzReader, err := gzip.NewReader(bytes.NewReader(respBody)); err == nil {
				if uncompressed, err := io.ReadAll(gzReader); err == nil {
					respBody = uncompressed
					resp.Header.Del("Content-Encoding")
				}
				gzReader.Close()
			}
		}

		resp.Header.Del("Transfer-Encoding")
		resp.Header.Del("Content-Encoding")
		resp.Header.Set("Content-Length", strconv.Itoa(len(respBody)))

		onSuccess(respBody, nil, nil)

		outHeader := resp.Header.Clone()
		if outHeader == nil {
			outHeader = make(http.Header)
		}

		return &http.Response{
			StatusCode:    resp.StatusCode,
			Status:        resp.Status,
			Proto:         "HTTP/1.1",
			ProtoMajor:    1,
			ProtoMinor:    1,
			Header:        outHeader,
			Body:          io.NopCloser(bytes.NewBuffer(respBody)),
			ContentLength: int64(len(respBody)),
			Request:       req,
		}, nil
	}

	resp.Proto = "HTTP/1.1"
	resp.ProtoMajor = 1
	resp.ProtoMinor = 1

	if resp.Body != nil {
		resp.Body = newRecordingBody(resp.Body, startTime, isStreaming, onSuccess, onError)
	} else {
		onSuccess(nil, nil, nil)
	}

	return resp, nil
}

func (i *HTTPInterceptor) recordRoundTrip(req *http.Request) (*http.Response, error) {
	// Read the request body
	var reqBodyBytes []byte
	if req.Body != nil {
		var err error
		reqBodyBytes, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, fmt.Errorf("record: failed to read request body: %w", err)
		}
		req.Body = io.NopCloser(bytes.NewBuffer(reqBodyBytes))
	}

	normalizedURL := i.normalizeURL(req.URL.String())
	correlatedSpanId := req.Header.Get("X-AeroGraph-Span-Id")

	isOverridden := false
	if i.OverrideConfig != nil && !i.overrideApplied && i.OverrideConfig.PromptText != "" {
		shouldOverride := false
		if correlatedSpanId != "" && (correlatedSpanId == i.OverrideConfig.ForkFromSpanId || (i.OverrideConfig.Overrides != nil && i.OverrideConfig.Overrides[correlatedSpanId] != "")) {
			shouldOverride = true
		} else if i.OverrideConfig.OriginalPromptText != "" {
			cleanOrig := stripRolePrefix(i.OverrideConfig.OriginalPromptText)
			prefixLen := len(cleanOrig)
			if prefixLen > 30 {
				prefixLen = 30
			}
			if cleanOrig != "" && bytes.Contains(reqBodyBytes, []byte(cleanOrig[:prefixLen])) {
				shouldOverride = true
			}
		}

		if shouldOverride {
			if rewritten, ok := RewriteRequestBodyPrompt(reqBodyBytes, i.OverrideConfig.OriginalPromptText, i.OverrideConfig.PromptText); ok {
				reqBodyBytes = rewritten
				req.Body = io.NopCloser(bytes.NewBuffer(rewritten))
				req.ContentLength = int64(len(rewritten))
				req.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
				isOverridden = true
				i.overrideApplied = true
				fmt.Printf("%s[RECORD] Rewrote request body with prompt override: %s%s\n",
					colorCyan, req.URL.String(), colorReset)
			}
		}
	}

	fmt.Printf("%s[RECORD]%s Proxying HTTP: %s %s\n",
		colorCyan, colorReset, req.Method, req.URL.String())

	return i.executeAndRecordLive(req, reqBodyBytes, normalizedURL, correlatedSpanId, "live_record", "", isOverridden)
}

// stripRolePrefix removes leading role tags like "human: ", "user: ", "system: ", "assistant: "
// that telemetry frameworks often prepend when serializing chat history to a trace span.
func stripRolePrefix(s string) string {
	trimmed := strings.TrimSpace(s)
	lower := strings.ToLower(trimmed)
	for _, p := range []string{"human:", "user:", "system:", "assistant:"} {
		if strings.HasPrefix(lower, p) {
			return strings.TrimSpace(trimmed[len(p):])
		}
	}
	return trimmed
}

// RewriteRequestBodyPrompt inspects an outbound LLM request body and updates the prompt content.
func RewriteRequestBodyPrompt(body []byte, originalPrompt, newPrompt string) ([]byte, bool) {
	if len(body) == 0 || newPrompt == "" {
		return body, false
	}

	cleanNew := stripRolePrefix(newPrompt)
	cleanOrig := stripRolePrefix(originalPrompt)

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err == nil {
		// 1. Check for "messages" array (standard Chat Completions API)
		if rawMsgs, ok := payload["messages"].([]any); ok && len(rawMsgs) > 0 {
			targetIdx := -1
			for i := len(rawMsgs) - 1; i >= 0; i-- {
				if m, ok := rawMsgs[i].(map[string]any); ok {
					content, _ := m["content"].(string)
					role, _ := m["role"].(string)
					if cleanOrig != "" {
						if content == cleanOrig || strings.Contains(content, cleanOrig) || strings.Contains(cleanOrig, content) {
							targetIdx = i
							break
						}
					}
					if targetIdx == -1 && (role == "user" || role == "human") {
						targetIdx = i
					}
				}
			}

			if targetIdx == -1 {
				targetIdx = len(rawMsgs) - 1
			}

			if targetIdx >= 0 && targetIdx < len(rawMsgs) {
				if m, ok := rawMsgs[targetIdx].(map[string]any); ok {
					m["content"] = cleanNew
					newBytes, err := json.Marshal(payload)
					if err == nil {
						return newBytes, true
					}
				}
			}
		}

		// 2. Check for "prompt" field (Completions API)
		if _, ok := payload["prompt"]; ok {
			payload["prompt"] = cleanNew
			newBytes, err := json.Marshal(payload)
			if err == nil {
				return newBytes, true
			}
		}
	}

	// 3. Fallback: Byte substring replacement if cleanOrig is present in body
	if cleanOrig != "" && bytes.Contains(body, []byte(cleanOrig)) {
		newBytes := bytes.Replace(body, []byte(cleanOrig), []byte(cleanNew), 1)
		return newBytes, true
	}

	return body, false
}

func (i *HTTPInterceptor) ensureCassetteIndex() {
	i.idxOnce.Do(func() {
		i.cassetteIdx = newCassetteIndex(i.CurrentRun.Steps, i.normalizeURL)
	})
}

func (i *HTTPInterceptor) replayRoundTrip(req *http.Request) (*http.Response, error) {
	// Build the hashed index once (O(n) build, O(1) lookup thereafter)
	i.ensureCassetteIndex()

	// Read incoming request body
	var incomingReqBodyBytes []byte
	if req.Body != nil {
		var err error
		incomingReqBodyBytes, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, fmt.Errorf("replay: failed to read request body: %w", err)
		}
		req.Body = io.NopCloser(bytes.NewBuffer(incomingReqBodyBytes))
	}

	normalizedURL := i.normalizeURL(req.URL.String())
	reqKey := RequestKey(req.Method, normalizedURL, incomingReqBodyBytes)
	correlatedSpanId := req.Header.Get("X-AeroGraph-Span-Id")

	isOverridden := false
	if i.OverrideConfig != nil && !i.overrideApplied && i.OverrideConfig.PromptText != "" {
		shouldOverride := false
		if correlatedSpanId != "" && (correlatedSpanId == i.OverrideConfig.ForkFromSpanId || (i.OverrideConfig.Overrides != nil && i.OverrideConfig.Overrides[correlatedSpanId] != "")) {
			shouldOverride = true
		} else if i.OverrideConfig.OriginalPromptText != "" {
			cleanOrig := stripRolePrefix(i.OverrideConfig.OriginalPromptText)
			prefixLen := len(cleanOrig)
			if prefixLen > 30 {
				prefixLen = 30
			}
			if cleanOrig != "" && bytes.Contains(incomingReqBodyBytes, []byte(cleanOrig[:prefixLen])) {
				shouldOverride = true
			}
		}

		if shouldOverride {
			if rewritten, ok := RewriteRequestBodyPrompt(incomingReqBodyBytes, i.OverrideConfig.OriginalPromptText, i.OverrideConfig.PromptText); ok {
				incomingReqBodyBytes = rewritten
				req.Body = io.NopCloser(bytes.NewBuffer(rewritten))
				req.ContentLength = int64(len(rewritten))
				req.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
				reqKey = RequestKey(req.Method, normalizedURL, rewritten)
				isOverridden = true
				i.overrideApplied = true
				fmt.Printf("%s[REPLAY] Rewrote request body with prompt override: %s (key: %s...)%s\n",
					colorCyan, req.URL.String(), reqKey[:8], colorReset)
			}
		}
	}

	if isOverridden {
		fmt.Printf("%s[REPLAY] Executing overridden prompt live: %s %s%s\n",
			colorCyan, req.Method, req.URL.String(), colorReset)
		return i.executeAndRecordLive(req, incomingReqBodyBytes, normalizedURL, correlatedSpanId, "fallback", "replay_safe", true)
	}

	// must_execute: if host is in live-hosts list, always forward live
	if i.isLiveHost(req.URL.Host) {
		fmt.Printf("%s[REPLAY] must_execute: %s %s (matches live-host pattern)%s\n",
			colorYellow, req.Method, req.URL.String(), colorReset)
		return i.executeAndRecordLive(req, incomingReqBodyBytes, normalizedURL, correlatedSpanId, "must_execute", "must_execute", false)
	}

	// O(1) hash-map lookup
	startLookup := time.Now()
	matchIdx := i.cassetteIdx.lookup(reqKey)
	lookupMs := float64(time.Since(startLookup).Microseconds()) / 1000.0

	if matchIdx >= 0 {
		step := i.CurrentRun.Steps[matchIdx]
		recordedResp := step.Response
		fmt.Printf("%s[REPLAY] Cache hit: %s %s (key: %s..., step: %d, lookup: %.3fms)%s\n",
			colorGreen, req.Method, req.URL.String(), reqKey[:8], matchIdx, lookupMs, colorReset)

		i.mu.Lock()
		i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
			RequestKey:         reqKey,
			CorrelatedSpanId:   correlatedSpanId,
			ReplaySource:       "cache",
			ReplayLatencyMs:    lookupMs,
			StreamingPreserved: recordedResp.StreamingPreserved,
			Decision:           "cache_hit",
			EffectiveClass:     "replay_safe",
			Overridden:         isOverridden,
		})
		i.mu.Unlock()

		// Reconstruct streaming response if chunks were preserved
		var body io.ReadCloser
		if recordedResp.StreamingPreserved && len(recordedResp.Chunks) > 0 {
			body = newChunkedReplayReader(recordedResp.Chunks, recordedResp.ChunkDelaysMs, i.RealtimePlayback)
		} else {
			body = io.NopCloser(bytes.NewBuffer(recordedResp.Body))
		}

		outHeader := recordedResp.Headers.Clone()
		if outHeader == nil {
			outHeader = make(http.Header)
		}
		outHeader.Del("Transfer-Encoding")
		outHeader.Del("Content-Encoding")
		outHeader.Set("Content-Length", strconv.Itoa(len(recordedResp.Body)))

		return &http.Response{
			StatusCode:    recordedResp.StatusCode,
			Status:        recordedResp.Status,
			Proto:         "HTTP/1.1",
			ProtoMajor:    1,
			ProtoMinor:    1,
			Header:        outHeader,
			Body:          body,
			ContentLength: int64(len(recordedResp.Body)),
			Request:       req,
		}, nil
	}

	// Cache miss
	if i.Fallback {
		fmt.Printf("%s[REPLAY] Cache miss — fallback to live: %s %s%s\n",
			colorYellow, req.Method, req.URL.String(), colorReset)
		return i.executeAndRecordLive(req, incomingReqBodyBytes, normalizedURL, correlatedSpanId, "fallback", "replay_safe", false)
	}

	fmt.Printf("%s[REPLAY] ERROR: No cache entry for %s %s (key: %s...)%s\n",
		colorRed, req.Method, req.URL.String(), reqKey[:8], colorReset)
	i.mu.Lock()
	i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
		RequestKey:       reqKey,
		CorrelatedSpanId: correlatedSpanId,
		ReplaySource:     "live",
		Decision:         "cache_miss_error",
	})
	i.mu.Unlock()
	return nil, fmt.Errorf("replay error: no matching recorded step found for request %s %s (key: %s)",
		req.Method, req.URL.String(), reqKey)
}

func (i *HTTPInterceptor) normalizeURL(uStr string) string {
	return NormalizeURLForKey(uStr, i.IgnoreQueryParams)
}

// chunkedReplayReader replays chunk bytes in order with discrete chunk boundaries and optional timing reconstruction.
type chunkedReplayReader struct {
	chunks      [][]byte
	chunkDelays []int64
	chunkIdx    int
	chunkOff    int
	realtime    bool
}

// NewChunkedReplayReader creates an io.ReadCloser that emits chunks one by one.
func NewChunkedReplayReader(chunks [][]byte, chunkDelays []int64, realtime bool) io.ReadCloser {
	return &chunkedReplayReader{
		chunks:      chunks,
		chunkDelays: chunkDelays,
		chunkIdx:    0,
		chunkOff:    0,
		realtime:    realtime,
	}
}

func newChunkedReplayReader(chunks [][]byte, chunkDelays []int64, realtime bool) io.ReadCloser {
	return NewChunkedReplayReader(chunks, chunkDelays, realtime)
}

func (r *chunkedReplayReader) Read(p []byte) (int, error) {
	if r.chunkIdx >= len(r.chunks) {
		return 0, io.EOF
	}

	currentChunk := r.chunks[r.chunkIdx]

	// When entering a new chunk (chunkOff == 0), apply its recorded timing delay (TTFT for chunk 0, inter-chunk delay for subsequent chunks)
	if r.chunkOff == 0 && r.realtime {
		delay := time.Duration(0)
		if r.chunkIdx < len(r.chunkDelays) && r.chunkDelays[r.chunkIdx] > 0 {
			delay = time.Duration(r.chunkDelays[r.chunkIdx]) * time.Millisecond
		} else {
			delay = 5 * time.Millisecond
		}
		if delay > 0 {
			time.Sleep(delay)
		}
	}

	remaining := len(currentChunk) - r.chunkOff
	if remaining <= 0 {
		r.chunkIdx++
		r.chunkOff = 0
		if r.chunkIdx >= len(r.chunks) {
			return 0, io.EOF
		}
		return r.Read(p)
	}

	toCopy := len(p)
	if toCopy > remaining {
		toCopy = remaining
	}
	copy(p, currentChunk[r.chunkOff:r.chunkOff+toCopy])
	r.chunkOff += toCopy

	// If we reached the end of this chunk, advance to the next chunk for the subsequent Read call
	if r.chunkOff >= len(currentChunk) {
		r.chunkIdx++
		r.chunkOff = 0
	}

	return toCopy, nil
}

func (r *chunkedReplayReader) Close() error {
	r.chunkIdx = len(r.chunks)
	return nil
}

// NormalizeURLForKey is exported for use in tests and benchmarks.
func NormalizeURLForKey(rawURL string, ignoreParams []string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	for _, p := range ignoreParams {
		q.Del(p)
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sorted := url.Values{}
	for _, k := range keys {
		vals := q[k]
		sort.Strings(vals)
		sorted[k] = vals
	}
	u.RawQuery = sorted.Encode()
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	return u.String()
}

// LoadOverrideFile loads prompt and span overrides from a JSON file.
func (i *HTTPInterceptor) LoadOverrideFile(filePath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	var cfg OverrideConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	i.OverrideConfig = &cfg
	return nil
}

// WriteAnnotationLog serializes the annotation log to JSON. Called by the Orchestrator
// via --annotation-log flag after a run completes.
func (i *HTTPInterceptor) WriteAnnotationLog() []byte {
	i.mu.Lock()
	defer i.mu.Unlock()
	data, _ := json.Marshal(i.AnnotationLog)
	return data
}
