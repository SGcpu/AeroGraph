// Package proxy provides MITM HTTPS proxy functionality.
// SECURITY NOTE (FR-037): The CA private key is NEVER persisted to disk.
// All CA material lives in an os.MkdirTemp directory that is wiped on exit.
// The Orchestrator MUST NOT invoke aerograph-replay-core unattended until
// this package has been confirmed to clean up CA material on all exit paths.
package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CAManager manages an ephemeral MITM Certificate Authority.
//
// Security contract (FR-037):
//   - The CA key is generated fresh per session into an os.MkdirTemp directory.
//   - No CA material is written to .agent-replay/ca/ or any persistent path.
//   - The caller MUST call Cleanup() (or ensure it is deferred / signal-trapped)
//     before the process exits.
//   - Cleanup() calls os.RemoveAll on the temp directory.
type CAManager struct {
	caCert  *x509.Certificate
	caKey   interface{}
	tempDir string // os.MkdirTemp dir — wiped by Cleanup()
	mu      sync.Mutex
	certs   map[string]*tls.Certificate // per-host cert cache (in-memory only)
}

// NewCAManager creates a new ephemeral CAManager.
// The CA key and certificate are written to a temporary directory created with
// os.MkdirTemp (prefix "aerograph-replay-ca-*"). Call Cleanup() when done.
//
// SECURITY: Do NOT pass a persistent path as baseDir to override this behavior.
func NewCAManager() (*CAManager, error) {
	// Create ephemeral temp directory — this is the ONLY place CA material lives.
	tempDir, err := os.MkdirTemp("", "aerograph-replay-ca-*")
	if err != nil {
		return nil, fmt.Errorf("ca: failed to create ephemeral CA directory: %w", err)
	}

	cm := &CAManager{
		tempDir: tempDir,
		certs:   make(map[string]*tls.Certificate),
	}

	if err := cm.generateCA(); err != nil {
		// Attempt cleanup even on error
		os.RemoveAll(tempDir) //nolint:errcheck
		return nil, err
	}

	return cm, nil
}

// generateCA generates a fresh ECDSA P-256 CA certificate and key.
// Validity: 24 hours (ephemeral session use only).
// The certificate is written to the temp directory so it can be exported for
// system trust (e.g. SSL_CERT_FILE), but the private key is also in tempDir
// and is wiped by Cleanup().
func (cm *CAManager) generateCA() error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("ca: failed to generate ECDSA key: %w", err)
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("ca: failed to generate serial number: %w", err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"AeroGraph Replay CA (ephemeral)"},
			CommonName:   "AeroGraph Replay Interception Authority",
		},
		// 26 hours: 1hr before now, 25hrs validity — enough for a dev session.
		NotBefore:             now.Add(-1 * time.Hour),
		NotAfter:              now.Add(25 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return fmt.Errorf("ca: failed to create certificate: %w", err)
	}

	// Write cert to temp dir (readable by child processes via SSL_CERT_FILE)
	certPath := filepath.Join(cm.tempDir, "ca.crt")
	certOut, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("ca: failed to write CA cert: %w", err)
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		certOut.Close()
		return fmt.Errorf("ca: failed to PEM-encode CA cert: %w", err)
	}
	certOut.Close()

	// SECURITY (FR-037): The CA private key is strictly kept in-memory (cm.caKey)
	// and is NEVER written to disk. Only the public ca.crt is written to cm.tempDir
	// so child processes can trust it via SSL_CERT_FILE / NODE_EXTRA_CA_CERTS.
	cm.caKey = priv
	cm.caCert, err = x509.ParseCertificate(derBytes)
	if err != nil {
		return fmt.Errorf("ca: failed to parse self-signed certificate: %w", err)
	}

	fmt.Printf("\033[36m[CA] Ephemeral CA created in %s (wiped on exit, private key in-memory only)\033[0m\n", cm.tempDir)
	return nil
}

// CertPath returns the path to the ephemeral CA certificate file.
// Pass this as SSL_CERT_FILE / REQUESTS_CA_BUNDLE / NODE_EXTRA_CA_CERTS to the child process.
func (cm *CAManager) CertPath() string {
	return filepath.Join(cm.tempDir, "ca.crt")
}

// Cleanup removes the ephemeral CA directory and all key material.
// Safe to call multiple times. MUST be called before process exit.
func (cm *CAManager) Cleanup() {
	if cm.tempDir == "" {
		return
	}
	if err := os.RemoveAll(cm.tempDir); err != nil {
		fmt.Fprintf(os.Stderr, "\033[33m[CA] Warning: failed to clean up CA temp dir %s: %v\033[0m\n",
			cm.tempDir, err)
	} else {
		fmt.Printf("\033[36m[CA] Ephemeral CA cleaned up: %s\033[0m\n", cm.tempDir)
	}
	cm.tempDir = ""
}

// GetCertificate returns a dynamically signed certificate for the given host.
// Certificates are cached in memory (never persisted to disk).
func (cm *CAManager) GetCertificate(host string) (*tls.Certificate, error) {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	// Strip port if present
	h, _, err := net.SplitHostPort(host)
	if err == nil {
		host = h
	}

	if cert, ok := cm.certs[host]; ok {
		return cert, nil
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ca: failed to generate leaf key for %s: %w", host, err)
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("ca: failed to generate leaf serial for %s: %w", host, err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName: host,
		},
		NotBefore:   now.Add(-1 * time.Hour),
		NotAfter:    now.Add(24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:    []string{host},
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, template, cm.caCert, &priv.PublicKey, cm.caKey)
	if err != nil {
		return nil, fmt.Errorf("ca: failed to create leaf cert for %s: %w", host, err)
	}

	cert := &tls.Certificate{
		Certificate: [][]byte{derBytes},
		PrivateKey:  priv,
	}
	cm.certs[host] = cert
	return cert, nil
}
