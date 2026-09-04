package interceptor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"iter"
	"sync"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/storage"

	"google.golang.org/genai"
)

// LLMInterceptor wraps a genai.Client to intercept LLM calls for a specific model.
// In replay mode it uses a SHA-256 hashed content-key for O(1) lookup (T003).
// It also intercepts GenerateContentStream (T012 / FR-038).
type LLMInterceptor struct {
	Client      *genai.Client
	ModelName   string
	Mode        Mode
	Storage     storage.Storage
	CurrentRun  *core.Run
	// hashed index for LLM replay: contentKey → ordered list of step indices
	llmIndex   map[string][]int
	indexBuilt bool
	usedSteps  map[int]bool
	mu         sync.Mutex
}

// NewLLMInterceptor creates a new LLMInterceptor.
func NewLLMInterceptor(client *genai.Client, modelName string, mode Mode, s storage.Storage, currentRun *core.Run) *LLMInterceptor {
	return &LLMInterceptor{
		Client:    client,
		ModelName: modelName,
		Mode:      mode,
		Storage:   s,
		CurrentRun: currentRun,
		llmIndex:  make(map[string][]int),
		usedSteps: make(map[int]bool),
	}
}

// llmContentKey computes a deterministic SHA-256 hash over the LLM request inputs.
// Key = SHA256(modelName + "\n" + SHA256(JSON(contents)) + "\n" + SHA256(JSON(config)))
// This replaces the upstream reflect.DeepEqual linear scan (T003).
func llmContentKey(modelName string, contents []*genai.Content, cfg *genai.GenerateContentConfig) string {
	contentsJSON, _ := json.Marshal(contents)
	contentsHash := sha256.Sum256(contentsJSON)

	cfgJSON, _ := json.Marshal(cfg)
	cfgHash := sha256.Sum256(cfgJSON)

	combined := modelName + "\n" + hex.EncodeToString(contentsHash[:]) + "\n" + hex.EncodeToString(cfgHash[:])
	h := sha256.Sum256([]byte(combined))
	return hex.EncodeToString(h[:])
}

// buildLLMIndex constructs the hash-based index over recorded LLM steps.
// Called once on the first replay call. Must be called with mu held.
func (i *LLMInterceptor) buildLLMIndex() {
	if i.indexBuilt {
		return
	}
	for idx, step := range i.CurrentRun.Steps {
		if step.Type != core.StepTypeLLM || step.LLMInput == nil {
			continue
		}
		key := llmContentKey(step.LLMInput.Model, step.LLMInput.Contents, step.LLMInput.Config)
		i.llmIndex[key] = append(i.llmIndex[key], idx)
	}
	i.indexBuilt = true
}

// GenerateContent intercepts the genai.Models.GenerateContent call.
func (i *LLMInterceptor) GenerateContent(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) (*genai.GenerateContentResponse, error) {
	switch i.Mode {
	case ModeRecord:
		return i.recordGenerateContent(ctx, contents, cfg)
	case ModeReplay:
		return i.replayGenerateContent(ctx, contents, cfg)
	case ModePassthrough:
		fallthrough
	default:
		return i.Client.Models.GenerateContent(ctx, i.ModelName, contents, cfg)
	}
}

// GenerateContentStream intercepts the genai.Models.GenerateContentStream call (FR-038).
// Returns iter.Seq2[*genai.GenerateContentResponse, error] matching the genai API.
func (i *LLMInterceptor) GenerateContentStream(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) iter.Seq2[*genai.GenerateContentResponse, error] {
	switch i.Mode {
	case ModeRecord:
		return i.recordGenerateContentStream(ctx, contents, cfg)
	case ModeReplay:
		return i.replayGenerateContentStream(ctx, contents, cfg)
	case ModePassthrough:
		fallthrough
	default:
		return i.Client.Models.GenerateContentStream(ctx, i.ModelName, contents, cfg)
	}
}

func (i *LLMInterceptor) recordGenerateContent(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) (*genai.GenerateContentResponse, error) {
	resp, err := i.Client.Models.GenerateContent(ctx, i.ModelName, contents, cfg)
	if err != nil {
		return nil, err
	}

	i.mu.Lock()
	defer i.mu.Unlock()

	correlatedSpanId := correlatedSpanIDFromContext(ctx)
	reqKey := llmContentKey(i.ModelName, contents, cfg)

	llmStep := core.Step{
		Type: core.StepTypeLLM,
		LLMInput: &core.GeminiGenerateContentRequest{
			Model:    i.ModelName,
			Contents: contents,
			Config:   cfg,
		},
		LLMOutput: &core.GeminiGenerateContentResponse{
			Response:           resp,
			StreamingPreserved: false,
			CorrelatedSpanId:   correlatedSpanId,
			RequestKey:         reqKey,
		},
	}
	i.CurrentRun.Steps = append(i.CurrentRun.Steps, llmStep)
	if i.Storage != nil {
		i.Storage.AppendStep(i.CurrentRun.RunID, llmStep)
	}
	fmt.Printf("%s[RECORD]%s Captured LLM GenerateContent: %s (key: %s...)\n",
		colorCyan, colorReset, i.ModelName, reqKey[:8])

	return resp, nil
}

// recordGenerateContentStream intercepts streaming LLM calls, capturing each chunk (FR-038).
// Returns a wrapped iterator that collects chunks while yielding them to the caller.
func (i *LLMInterceptor) recordGenerateContentStream(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) iter.Seq2[*genai.GenerateContentResponse, error] {
	return func(yield func(*genai.GenerateContentResponse, error) bool) {
		var collectedChunks []*genai.GenerateContentResponse

		for chunk, err := range i.Client.Models.GenerateContentStream(ctx, i.ModelName, contents, cfg) {
			if err != nil {
				// Save whatever was collected so far before yielding the error
				if len(collectedChunks) > 0 {
					i.saveStreamChunks(ctx, contents, cfg, collectedChunks)
				}
				yield(nil, err)
				return
			}
			collectedChunks = append(collectedChunks, chunk)
			if !yield(chunk, nil) {
				// Caller stopped iteration early
				break
			}
		}

		// Save all collected chunks to the cassette
		if len(collectedChunks) > 0 {
			i.saveStreamChunks(ctx, contents, cfg, collectedChunks)
		}
	}
}

// saveStreamChunks persists collected streaming chunks to the cassette.
func (i *LLMInterceptor) saveStreamChunks(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig, chunks []*genai.GenerateContentResponse) {
	i.mu.Lock()
	defer i.mu.Unlock()

	correlatedSpanId := correlatedSpanIDFromContext(ctx)
	reqKey := llmContentKey(i.ModelName, contents, cfg)

	// Use last chunk as combined response (it often contains accumulated usage metadata)
	var combinedResp *genai.GenerateContentResponse
	if len(chunks) > 0 {
		combinedResp = chunks[len(chunks)-1]
	}

	llmStep := core.Step{
		Type: core.StepTypeLLM,
		LLMInput: &core.GeminiGenerateContentRequest{
			Model:    i.ModelName,
			Contents: contents,
			Config:   cfg,
		},
		LLMOutput: &core.GeminiGenerateContentResponse{
			Response:           combinedResp,
			StreamChunks:       chunks,
			StreamingPreserved: len(chunks) > 1,
			CorrelatedSpanId:   correlatedSpanId,
			RequestKey:         reqKey,
		},
	}
	i.CurrentRun.Steps = append(i.CurrentRun.Steps, llmStep)
	if i.Storage != nil {
		i.Storage.AppendStep(i.CurrentRun.RunID, llmStep)
	}
	fmt.Printf("%s[RECORD]%s Captured LLM stream: %s (%d chunks, streamingPreserved: %v, key: %s...)\n",
		colorCyan, colorReset, i.ModelName, len(chunks), len(chunks) > 1, reqKey[:8])
}

func (i *LLMInterceptor) replayGenerateContent(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) (*genai.GenerateContentResponse, error) {
	i.mu.Lock()
	defer i.mu.Unlock()

	i.buildLLMIndex()

	key := llmContentKey(i.ModelName, contents, cfg)
	indices, ok := i.llmIndex[key]
	if !ok {
		return nil, fmt.Errorf("replay error: no matching recorded LLM step found for model %s (key: %s)", i.ModelName, key)
	}

	for _, idx := range indices {
		if i.usedSteps[idx] {
			continue
		}
		step := i.CurrentRun.Steps[idx]
		if step.LLMOutput == nil {
			continue
		}
		i.usedSteps[idx] = true
		fmt.Printf("%s[REPLAY] LLM cache hit: %s (step: %d, key: %s...)%s\n",
			colorGreen, i.ModelName, idx, key[:8], colorReset)
		return step.LLMOutput.Response, nil
	}

	return nil, fmt.Errorf("replay error: all matching LLM steps consumed for model %s (key: %s)", i.ModelName, key)
}

// replayGenerateContentStream replays a recorded streaming LLM call (FR-038).
// Emits stored chunks as an iter.Seq2 iterator.
func (i *LLMInterceptor) replayGenerateContentStream(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) iter.Seq2[*genai.GenerateContentResponse, error] {
	i.mu.Lock()
	i.buildLLMIndex()

	key := llmContentKey(i.ModelName, contents, cfg)
	indices, ok := i.llmIndex[key]

	var foundStep *core.Step
	if ok {
		for _, idx := range indices {
			if !i.usedSteps[idx] {
				step := i.CurrentRun.Steps[idx]
				if step.LLMOutput != nil {
					i.usedSteps[idx] = true
					foundStep = &step
					break
				}
			}
		}
	}
	i.mu.Unlock()

	if foundStep == nil {
		return func(yield func(*genai.GenerateContentResponse, error) bool) {
			yield(nil, fmt.Errorf("replay error: no matching LLM stream found for model %s (key: %s)", i.ModelName, key))
		}
	}

	output := foundStep.LLMOutput
	streamingPreserved := output.StreamingPreserved && len(output.StreamChunks) > 0

	fmt.Printf("%s[REPLAY] LLM stream hit: %s (streaming_preserved: %v, key: %s...)%s\n",
		colorGreen, i.ModelName, streamingPreserved, key[:8], colorReset)

	if streamingPreserved {
		// Return stored chunks as iterator
		chunks := output.StreamChunks
		return func(yield func(*genai.GenerateContentResponse, error) bool) {
			for _, chunk := range chunks {
				if !yield(chunk, nil) {
					return
				}
			}
		}
	}

	// Fall back to emitting the single combined response
	singleResp := output.Response
	return func(yield func(*genai.GenerateContentResponse, error) bool) {
		if singleResp != nil {
			yield(singleResp, nil)
		}
	}
}

// correlatedSpanIDFromContext extracts the AeroGraph span ID from context if injected.
func correlatedSpanIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v := ctx.Value(aeroSpanIDKey{}); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// aeroSpanIDKey is the context key type for AeroGraph span IDs.
type aeroSpanIDKey struct{}

// InjectSpanID returns a new context with the AeroGraph span ID set.
func InjectSpanID(ctx context.Context, spanID string) context.Context {
	return context.WithValue(ctx, aeroSpanIDKey{}, spanID)
}
