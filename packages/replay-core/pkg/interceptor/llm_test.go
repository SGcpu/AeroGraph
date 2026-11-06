package interceptor

import (
	"context"
	"testing"

	"aerograph.dev/replay-core/pkg/core"
	"google.golang.org/genai"
)

func TestLLMInterceptor_ReplayMatching(t *testing.T) {
	ctx := context.Background()
	
	// Create a mock response
	mockResp := &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{
			{
				Content: &genai.Content{
					Parts: []*genai.Part{
						{Text: "Replayed response"},
					},
				},
			},
		},
	}

	run := &core.Run{
		RunID: "test-run",
		Steps: []core.Step{
			{
				Type: core.StepTypeLLM,
				LLMInput: &core.GeminiGenerateContentRequest{
					Model:    "gemini-2.0-flash",
					Contents: genai.Text("Hello"),
				},
				LLMOutput: &core.GeminiGenerateContentResponse{
					Response: mockResp,
				},
			},
		},
	}

	interceptor := NewLLMInterceptor(nil, "gemini-2.0-flash", ModeReplay, nil, run)

	t.Run("Match LLM", func(t *testing.T) {
		resp, err := interceptor.GenerateContent(ctx, genai.Text("Hello"), nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		if len(resp.Candidates) == 0 || resp.Candidates[0].Content.Parts[0].Text != "Replayed response" {
			t.Errorf("Unexpected response: %+v", resp)
		}
	})

	t.Run("No Match LLM (Content Mismatch)", func(t *testing.T) {
		_, err := interceptor.GenerateContent(ctx, genai.Text("Goodbye"), nil)
		if err == nil {
			t.Fatal("Expected error for no match, got nil")
		}
	})

	t.Run("No Match LLM (Model Mismatch)", func(t *testing.T) {
		interceptor.ModelName = "different-model"
		_, err := interceptor.GenerateContent(ctx, genai.Text("Hello"), nil)
		if err == nil {
			t.Fatal("Expected error for no match, got nil")
		}
	})
}

