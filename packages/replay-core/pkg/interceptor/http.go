package interceptor

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
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
	RequestKey        string  `json:"requestKey"`
	CorrelatedSpanId  string  `json:"correlatedSpanId,omitempty"`
	ReplaySource      string  `json:"replaySource"` // "cache" | "live"
	ReplayLatencyMs   float64 `json:"replayLatencyMs,omitempty"`
	StreamingPreserved bool   `json:"streamingPreserved"`
	Decision          string  `json:"decision"` // "cache_hit" | "cache_miss" | "must_execute" | "fallback"
	MatchedPattern    string  `json:"matchedPattern,omitempty"`
	EffectiveClass    string  `json:"effectiveClass,omitempty"` // "replay_safe" | "must_execute"
	Overridden        bool    `json:"overridden,omitempty"`
}

// OverrideConfig represents prompt/span substitutions supplied via --override-file.
type OverrideConfig struct {
	ForkFromSpanId string            `json:"forkFromSpanId,omitempty"`
	PromptText     string            `json:"promptText,omitempty"`
	Overrides      map[string]string `json:"overrides,omitempty"`
}

// requestKey computes K(s) = SHA256(method ‖ normalizedUrl ‖ SHA256(body))
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

// LookupWithoutMarking performs a key lookup without marking the index used.
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
	Fallback          bool     // If true, call real network when no match is found
	IgnoreHeaders     []string
	IgnoreQueryParams []string
	LiveHosts         []string // Host glob patterns that always go live (must_execute)
	AnnotationLog     []AnnotationEntry
	OverrideConfig    *OverrideConfig
	// hashed index — populated on first replay RoundTrip from CurrentRun.Steps
	cassetteIdx *cassetteIndex
	idxOnce     sync.Once
	NetworkCallCount int
	mu              sync.Mutex
}

// NewHTTPInterceptor creates a new HTTPInterceptor.
func NewHTTPInterceptor(mode Mode, s storage.Storage, currentRun *core.Run) *HTTPInterceptor {
	return &HTTPInterceptor{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Mode:              mode,
		Storage:           s,
		CurrentRun:        currentRun,
		IgnoreHeaders:     []string{"User-Agent", "Date", "Authorization", "X-Amz-Date"},
		IgnoreQueryParams: []string{"timestamp", "nonce", "api_key"},
		AnnotationLog:     []AnnotationEntry{},
	}
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

	startTime := time.Now()

	// Perform actual call — for streaming responses we pass chunks through
	resp, err := i.Transport.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	// Read response body (streaming support in Phase 0.5 wraps this with chunk capture)
	respBody, chunks, streamingPreserved, err := captureResponse(resp)
	if err != nil {
		return nil, err
	}

	latencyMs := float64(time.Since(startTime).Microseconds()) / 1000.0

	i.mu.Lock()
	i.NetworkCallCount++

	normalizedURL := i.normalizeURL(req.URL.String())
	reqKey := RequestKey(req.Method, normalizedURL, reqBodyBytes)
	correlatedSpanId := req.Header.Get("X-AeroGraph-Span-Id")

	httpStep := core.Step{
		Type: core.StepTypeHTTP,
		Request: &core.HTTPRequest{
			Method:  req.Method,
			URL:     req.URL.String(),
			Headers: req.Header,
			Body:    reqBodyBytes,
		},
		Response: &core.HTTPResponse{
			Status:             resp.Status,
			StatusCode:         resp.StatusCode,
			Headers:            resp.Header,
			Body:               respBody,
			Chunks:             chunks,
			StreamingPreserved: streamingPreserved,
			RequestKey:         reqKey,
			CorrelatedSpanId:   correlatedSpanId,
			RecordedAt:         time.Now().UTC().Format(time.RFC3339Nano),
			RecordLatencyMs:    latencyMs,
		},
	}

	i.CurrentRun.Steps = append(i.CurrentRun.Steps, httpStep)
	if i.Storage != nil {
		i.Storage.AppendStep(i.CurrentRun.RunID, httpStep)
	}

	// Emit annotation
	i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
		RequestKey:        reqKey,
		CorrelatedSpanId:  correlatedSpanId,
		ReplaySource:      "live",
		StreamingPreserved: streamingPreserved,
		Decision:          "live_record",
	})

	i.mu.Unlock()

	fmt.Printf("%s[RECORD]%s Captured HTTP: %s %s (key: %s...)\n",
		colorCyan, colorReset, req.Method, req.URL.String(), reqKey[:8])

	// Return a fresh response body to the caller
	outHeader := resp.Header.Clone()
	if outHeader == nil {
		outHeader = make(http.Header)
	}
	outHeader.Del("Transfer-Encoding")
	outHeader.Set("Content-Length", strconv.Itoa(len(respBody)))

	return &http.Response{
		StatusCode:    resp.StatusCode,
		Status:        resp.Status,
		Proto:         resp.Proto,
		ProtoMajor:    resp.ProtoMajor,
		ProtoMinor:    resp.ProtoMinor,
		Header:        outHeader,
		Body:          io.NopCloser(bytes.NewBuffer(respBody)),
		ContentLength: int64(len(respBody)),
		Request:       req,
	}, nil
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
	if i.OverrideConfig != nil {
		if correlatedSpanId != "" && (correlatedSpanId == i.OverrideConfig.ForkFromSpanId || (i.OverrideConfig.Overrides != nil && i.OverrideConfig.Overrides[correlatedSpanId] != "")) {
			isOverridden = true
		} else if i.OverrideConfig.PromptText != "" && bytes.Contains(incomingReqBodyBytes, []byte(i.OverrideConfig.PromptText)) {
			isOverridden = true
		}
	}

	// must_execute: if host is in live-hosts list, always forward live
	if i.isLiveHost(req.URL.Host) {
		i.mu.Lock()
		i.NetworkCallCount++
		i.mu.Unlock()
		fmt.Printf("%s[REPLAY] must_execute: %s %s (matches live-host pattern)%s\n",
			colorYellow, req.Method, req.URL.String(), colorReset)

		i.mu.Lock()
		i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
			RequestKey:       reqKey,
			CorrelatedSpanId: correlatedSpanId,
			ReplaySource:     "live",
			Decision:         "must_execute",
			EffectiveClass:   "must_execute",
			Overridden:       isOverridden,
		})
		i.mu.Unlock()

		return i.Transport.RoundTrip(req)
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
			RequestKey:        reqKey,
			CorrelatedSpanId:  correlatedSpanId,
			ReplaySource:      "cache",
			ReplayLatencyMs:   lookupMs,
			StreamingPreserved: recordedResp.StreamingPreserved,
			Decision:          "cache_hit",
			EffectiveClass:    "replay_safe",
			Overridden:        isOverridden,
		})
		i.mu.Unlock()

		// Reconstruct streaming response if chunks were preserved
		var body io.ReadCloser
		if recordedResp.StreamingPreserved && len(recordedResp.Chunks) > 0 {
			body = newChunkedReplayReader(recordedResp.Chunks)
		} else {
			body = io.NopCloser(bytes.NewBuffer(recordedResp.Body))
		}

		outHeader := recordedResp.Headers.Clone()
		if outHeader == nil {
			outHeader = make(http.Header)
		}
		outHeader.Del("Transfer-Encoding")
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
		i.mu.Lock()
		i.NetworkCallCount++
		i.AnnotationLog = append(i.AnnotationLog, AnnotationEntry{
			RequestKey:       reqKey,
			CorrelatedSpanId: correlatedSpanId,
			ReplaySource:     "live",
			Decision:         "fallback",
			EffectiveClass:   "replay_safe",
		})
		i.mu.Unlock()
		return i.Transport.RoundTrip(req)
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
	u, err := url.Parse(uStr)
	if err != nil {
		return uStr
	}

	// Sort query params for determinism (params with same key are sorted by value)
	q := u.Query()
	for _, param := range i.IgnoreQueryParams {
		q.Del(param)
	}

	// Sort keys for canonical order
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

	// Lowercase scheme and host for canonicalization
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)

	return u.String()
}

// captureResponse reads the response body, preserving SSE/chunked chunks if present.
// Returns: (fullBody []byte, chunks [][]byte, streamingPreserved bool, err error)
func captureResponse(resp *http.Response) ([]byte, [][]byte, bool, error) {
	if resp.Body == nil {
		return nil, nil, false, nil
	}

	contentType := resp.Header.Get("Content-Type")
	transferEncoding := resp.TransferEncoding

	isSSE := strings.Contains(contentType, "text/event-stream")
	isChunked := false
	for _, te := range transferEncoding {
		if strings.ToLower(te) == "chunked" {
			isChunked = true
			break
		}
	}

	if isSSE || isChunked {
		// Streaming: read in chunks, preserve each
		return captureStreamingResponse(resp.Body)
	}

	// Non-streaming: read full body
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	return body, nil, false, err
}

// captureStreamingResponse reads SSE/chunked response body preserving individual chunks.
func captureStreamingResponse(body io.ReadCloser) ([]byte, [][]byte, bool, error) {
	defer body.Close()
	var allChunks [][]byte
	var fullBody bytes.Buffer
	buf := make([]byte, 4096)

	for {
		n, err := body.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			allChunks = append(allChunks, chunk)
			fullBody.Write(chunk)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fullBody.Bytes(), allChunks, len(allChunks) > 0, err
		}
	}

	return fullBody.Bytes(), allChunks, len(allChunks) > 1, nil
}

// chunkedReplayReader replays chunk bytes in order with appropriate timing simulation.
type chunkedReplayReader struct {
	chunks [][]byte
	pos    int
	buf    *bytes.Buffer
}

func newChunkedReplayReader(chunks [][]byte) io.ReadCloser {
	var b bytes.Buffer
	for _, c := range chunks {
		b.Write(c)
	}
	return io.NopCloser(&b)
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
