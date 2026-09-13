package core

import (
	"net/http"

	"google.golang.org/genai"
)

// Run represents a single recorded execution of an agent.
type Run struct {
	RunID           string `json:"run_id"`
	OriginalCommand string `json:"original_command"`
	Steps           []Step `json:"steps"`
}

// StepType defines the type of an interaction step.
type StepType string

const (
	StepTypeLLM  StepType = "llm"
	StepTypeHTTP StepType = "http"
)

// Step represents a single interaction within an agent's execution.
// It can be either an LLM interaction or an HTTP interaction.
type Step struct {
	Type      StepType                       `json:"type"`
	LLMInput  *GeminiGenerateContentRequest  `json:"llm_input,omitempty"`
	LLMOutput *GeminiGenerateContentResponse `json:"llm_output,omitempty"`
	// HTTP steps
	Request  *HTTPRequest  `json:"request,omitempty"`
	Response *HTTPResponse `json:"response,omitempty"`
}

// HTTPRequest represents a recorded HTTP request.
type HTTPRequest struct {
	Method  string      `json:"method"`
	URL     string      `json:"url"`
	Headers http.Header `json:"headers"`
	Body    []byte      `json:"body"`
}

// HTTPResponse represents a recorded HTTP response, including streaming chunk support (FR-010).
type HTTPResponse struct {
	Status     string      `json:"status"`
	StatusCode int         `json:"statusCode"`
	Headers    http.Header `json:"headers"`
	// Body is the full concatenated body bytes (always populated, even for streaming).
	Body []byte `json:"body"`
	// Chunks stores individual response chunks for streaming (SSE/chunked transfer).
	// When StreamingPreserved is true, Chunks is the authoritative source for replay.
	// Present only for streaming responses; nil for non-streaming.
	Chunks [][]byte `json:"chunks,omitempty"`
	// ChunkDelaysMs stores relative elapsed ms between consecutive chunks for timing reconstruction.
	ChunkDelaysMs []int64 `json:"chunkDelaysMs,omitempty"`
	// StreamingPreserved indicates whether individual chunks were captured.
	// If false, the response was buffered (non-streaming or fallback) and streaming
	// telemetry (TTFT, tokens/sec) from replay is not representative.
	StreamingPreserved bool `json:"streamingPreserved"`
	// RequestKey is the SHA-256 based deterministic key K(s) for this request.
	// Used to build the cassette index for O(1) lookup during replay.
	RequestKey string `json:"requestKey,omitempty"`
	// CorrelatedSpanId is the AeroGraph span ID from X-AeroGraph-Span-Id header, if present.
	CorrelatedSpanId string `json:"correlatedSpanId,omitempty"`
	// RecordedAt is the timestamp when this step was recorded.
	RecordedAt string `json:"recordedAt,omitempty"`
	// RecordLatencyMs is the actual network round-trip latency during recording.
	RecordLatencyMs float64 `json:"recordLatencyMs,omitempty"`
}

// GeminiGenerateContentRequest captures the input parameters for a Gemini GenerateContent call.
type GeminiGenerateContentRequest struct {
	Model    string                       `json:"model"`
	Contents []*genai.Content             `json:"contents"`
	Config   *genai.GenerateContentConfig `json:"config,omitempty"`
}

// GeminiGenerateContentResponse captures the output from a Gemini GenerateContent call.
type GeminiGenerateContentResponse struct {
	Response *genai.GenerateContentResponse `json:"response"`
	// StreamChunks stores individual streaming response chunks (FR-038).
	// Populated only when the call was GenerateContentStream.
	StreamChunks           []*genai.GenerateContentResponse `json:"streamChunks,omitempty"`
	StreamingPreserved     bool                             `json:"streamingPreserved"`
	CorrelatedSpanId       string                           `json:"correlatedSpanId,omitempty"`
	RequestKey             string                           `json:"requestKey,omitempty"`
}
