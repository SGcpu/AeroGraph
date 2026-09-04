package llmclient

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"time"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/interceptor"
	"aerograph.dev/replay-core/pkg/storage"

	"google.golang.org/genai"
)

// AeroReplGenerativeModel is a custom type that wraps LLMInterceptor to
// provide an intercepted GenerateContent method.
type AeroReplGenerativeModel struct {
	llmInterceptor *interceptor.LLMInterceptor
}

// GenerateContent implements a method similar to genai.Models.GenerateContent.
func (a *AeroReplGenerativeModel) GenerateContent(ctx context.Context, contents []*genai.Content, cfg *genai.GenerateContentConfig) (*genai.GenerateContentResponse, error) {
	return a.llmInterceptor.GenerateContent(ctx, contents, cfg)
}

// NewGenerativeModel creates a new intercepted model-like instance.
func NewGenerativeModel(ctx context.Context, apiKey string, modelName string) (*AeroReplGenerativeModel, error) {
	modeStr := os.Getenv("AEROREPL_MODE")
	runIDEnv := os.Getenv("AEROREPL_RUN_ID")

	var mode interceptor.Mode
	switch modeStr {
	case "record":
		mode = interceptor.ModeRecord
	case "replay":
		mode = interceptor.ModeReplay
	default:
		mode = interceptor.ModePassthrough
	}

	// Initialize storage if in record or replay mode
	var s storage.Storage
	var currentRun *core.Run

	// Only initialize storage if we are in record or replay mode
	if mode != interceptor.ModePassthrough {
		var err error
		s, err = storage.NewJSONStorage(".")
		if err != nil {
			return nil, fmt.Errorf("failed to initialize storage: %w", err)
		}

		if mode == interceptor.ModeRecord {
			runID := runIDEnv
			if runID == "" {
				rand.Seed(time.Now().UnixNano())
				var err error
				runID, err = s.GetNextRunID()
				if err != nil {
					return nil, fmt.Errorf("failed to get next run ID: %w", err)
				}
			}
			currentRun = &core.Run{
				RunID: runID,
				Steps: []core.Step{},
			}
			// Store the run ID in an environment variable so the CLI can retrieve it
			os.Setenv("AEROREPL_CURRENT_RUN_ID", runID)
		} else if mode == interceptor.ModeReplay {
			if runIDEnv == "" {
				return nil, fmt.Errorf("AEROREPL_RUN_ID environment variable not set for replay mode")
			}
			var err error
			currentRun, err = s.LoadRun(runIDEnv)
			if err != nil {
				return nil, fmt.Errorf("failed to load run '%s': %w", runIDEnv, err)
			}
		}
	}

	// Create the actual Gemini client
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey: apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}

	// Create and return our custom model with the interceptor
	llmInterceptor := interceptor.NewLLMInterceptor(client, modelName, mode, s, currentRun)
	return &AeroReplGenerativeModel{llmInterceptor: llmInterceptor}, nil
}

