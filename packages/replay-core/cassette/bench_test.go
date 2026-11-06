package cassette_test

import (
	"fmt"
	"testing"
	"time"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/interceptor"
)

// Helper to generate N mock steps
func generateMockSteps(n int) []core.Step {
	steps := make([]core.Step, n)
	for i := 0; i < n; i++ {
		steps[i] = core.Step{
			Type: core.StepTypeHTTP,
			Request: &core.HTTPRequest{
				Method: "POST",
				URL:    fmt.Sprintf("https://api.openai.com/v1/chat/completions?item=%d", i),
				Body:   []byte(fmt.Sprintf(`{"prompt": "hello %d"}`, i)),
			},
			Response: &core.HTTPResponse{
				Status:     "200 OK",
				StatusCode: 200,
				Body:       []byte(`{"choices": [{"message": {"content": "ok"}}]}`),
			},
		}
	}
	return steps
}

func BenchmarkCassetteLookup(b *testing.B) {
	sizes := []int{100, 500, 1000}

	for _, size := range sizes {
		b.Run(fmt.Sprintf("Size-%d", size), func(b *testing.B) {
			steps := generateMockSteps(size)
			ci := interceptor.NewCassetteIndexExported(steps)

			targetKey := interceptor.RequestKey("POST", fmt.Sprintf("https://api.openai.com/v1/chat/completions?item=%d", size/2), []byte(fmt.Sprintf(`{"prompt": "hello %d"}`, size/2)))

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				idx := ci.LookupWithoutMarking(targetKey)
				if idx < 0 {
					b.Fatalf("Expected key to be found")
				}
			}
		})
	}
}

func TestCassetteLookupLatencyUnder5ms(t *testing.T) {
	sizes := []int{100, 500, 1000}

	for _, size := range sizes {
		steps := generateMockSteps(size)
		ci := interceptor.NewCassetteIndexExported(steps)

		targetKey := interceptor.RequestKey("POST", fmt.Sprintf("https://api.openai.com/v1/chat/completions?item=%d", size/2), []byte(fmt.Sprintf(`{"prompt": "hello %d"}`, size/2)))

		start := time.Now()
		const iterations = 10000
		for i := 0; i < iterations; i++ {
			idx := ci.LookupWithoutMarking(targetKey)
			if idx < 0 {
				t.Fatalf("Expected key to be found")
			}
		}
		duration := time.Since(start)
		avgPerLookup := duration / iterations

		t.Logf("Cassette size %d: avg lookup time = %v (total for %d = %v)", size, avgPerLookup, iterations, duration)
		if avgPerLookup > 5*time.Millisecond {
			t.Errorf("Lookup time for size %d was %v, expected < 5ms", size, avgPerLookup)
		}
	}
}
