package proxy_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/interceptor"
)

func TestLiveHostsBypassesCassette(t *testing.T) {
	// Server acting as live endpoint
	liveServerHits := 0
	liveServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		liveServerHits++
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"live": true}`))
	}))
	defer liveServer.Close()

	liveURL, err := url.Parse(liveServer.URL)
	if err != nil {
		t.Fatalf("Failed to parse live server URL: %v", err)
	}

	// Cassette with a recorded response for the same path
	run := &core.Run{
		RunID: "live-hosts-run",
		Steps: []core.Step{
			{
				Type: core.StepTypeHTTP,
				Request: &core.HTTPRequest{
					Method: "GET",
					URL:    liveServer.URL + "/checkout",
				},
				Response: &core.HTTPResponse{
					Status:     "200 OK",
					StatusCode: 200,
					Body:       []byte(`{"cached": true}`),
				},
			},
		},
	}

	// Interceptor in replay mode with live-hosts set to liveServer's host
	httpInterceptor := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, nil, run)
	httpInterceptor.LiveHosts = []string{liveURL.Host}

	req, _ := http.NewRequest("GET", liveServer.URL+"/checkout", nil)
	resp, err := httpInterceptor.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip failed: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	// Must hit live server, not cassette
	if !bytes.Contains(body, []byte(`"live": true`)) {
		t.Fatalf("Expected live response, got cassette response: %s", string(body))
	}
	if liveServerHits != 1 {
		t.Fatalf("Expected 1 hit on live server, got %d", liveServerHits)
	}
}
