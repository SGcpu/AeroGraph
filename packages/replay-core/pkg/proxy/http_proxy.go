package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"aerograph.dev/replay-core/pkg/interceptor"
)

// HTTPProxy represents a local HTTP proxy server with MITM capabilities.
type HTTPProxy struct {
	Addr        string
	Interceptor *interceptor.HTTPInterceptor
	Server      *http.Server
	CAManager   *CAManager
}

// NewHTTPProxy creates a new HTTPProxy instance with an ephemeral CA.
// The caller MUST call caManager.Cleanup() (via defer or signal handler) before exit.
func NewHTTPProxy(addr string, inter *interceptor.HTTPInterceptor, caManager *CAManager) *HTTPProxy {
	proxy := &HTTPProxy{
		Addr:        addr,
		Interceptor: inter,
		CAManager:   caManager,
	}
	proxy.Server = &http.Server{
		Addr:    addr,
		Handler: proxy,
	}
	return proxy
}

// Start starts the HTTP proxy server in a goroutine.
func (p *HTTPProxy) Start() {
	go func() {
		log.Printf("Starting MITM HTTP proxy on %s\n", p.Addr)
		if err := p.Server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP proxy ListenAndServe: %v", err)
		}
	}()
}

// Stop gracefully shuts down the HTTP proxy server.
func (p *HTTPProxy) Stop() error {
	log.Printf("Stopping HTTP proxy on %s\n", p.Addr)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return p.Server.Shutdown(ctx)
}

// ServeHTTP implements the http.Handler interface for the proxy.
func (p *HTTPProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleHTTPS(w, r)
	} else {
		p.handleHTTP(w, r)
	}
}

func (p *HTTPProxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	fmt.Printf("Proxy handling HTTP request: %s %s\n", r.Method, r.URL.String())
	r.RequestURI = ""

	resp, err := p.Interceptor.RoundTrip(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for name, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck
}

func (p *HTTPProxy) handleHTTPS(w http.ResponseWriter, r *http.Request) {
	// Hijack the connection to perform MITM
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	// Inform client that tunnel is established
	if _, err = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}

	// Generate an ephemeral certificate for the host (signed by our ephemeral CA)
	cert, err := p.CAManager.GetCertificate(r.Host)
	if err != nil {
		fmt.Fprintf(w.(io.Writer), "HTTP/1.1 502 Bad Gateway\r\n\r\n") //nolint:errcheck
		return
	}

	// Start TLS handshake with client
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{*cert},
	}
	tlsConn := tls.Server(clientConn, tlsConfig)
	if err := tlsConn.Handshake(); err != nil {
		return
	}
	defer tlsConn.Close()

	// Now read the actual HTTP request from the TLS connection
	reader := bufio.NewReader(tlsConn)
	for {
		req, err := http.ReadRequest(reader)
		if err != nil {
			if err != io.EOF {
				log.Printf("Error reading request from TLS conn: %v", err)
			}
			break
		}

		// Repair the URL (ReadRequest might not get the full scheme/host)
		req.URL.Scheme = "https"
		req.URL.Host = r.Host
		req.RequestURI = ""

		// Use the interceptor's RoundTrip method
		resp, err := p.Interceptor.RoundTrip(req)
		if err != nil {
			log.Printf("Error during RoundTrip for %s %s: %v", req.Method, req.URL.String(), err)
			badGatewayHeaders := make(http.Header)
			badGatewayHeaders.Set("Content-Length", "0")
			resp = &http.Response{
				Status:        "502 Bad Gateway",
				StatusCode:    502,
				Proto:         "HTTP/1.1",
				ProtoMajor:    1,
				ProtoMinor:    1,
				Header:        badGatewayHeaders,
				Body:          io.NopCloser(bytes.NewReader(nil)),
				ContentLength: 0,
			}
		}

		if err := resp.Write(tlsConn); err != nil {
			break
		}

		if req.Close || resp.Close {
			break
		}
	}
}
