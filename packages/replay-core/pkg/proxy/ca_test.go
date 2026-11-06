package proxy_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aerograph.dev/replay-core/pkg/proxy"
)

// TestCAEphemeral verifies that the CA is created in a temp directory
// and that Cleanup() removes all key material (FR-037 / T021).
func TestCAEphemeral(t *testing.T) {
	ca, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("NewCAManager failed: %v", err)
	}

	// CA cert path should be in a temp dir, not .agent-replay/ca/
	certPath := ca.CertPath()
	if certPath == "" {
		t.Fatal("CertPath() returned empty string")
	}
	if strings.Contains(certPath, ".agent-replay") {
		t.Fatalf("CA cert path must NOT be under .agent-replay (persistent): %s", certPath)
	}
	if !strings.Contains(certPath, "aerograph-replay-ca-") {
		t.Fatalf("CA cert path should be in aerograph-replay-ca-* temp dir: %s", certPath)
	}

	// Cert file must exist before cleanup
	if _, err := os.Stat(certPath); err != nil {
		t.Fatalf("CA cert file should exist before cleanup: %v", err)
	}

	// SECURITY (FR-037): Key file must NEVER be written to disk
	keyPath := filepath.Join(filepath.Dir(certPath), "ca.key")
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("CA private key must NEVER be written to disk: %s exists", keyPath)
	}

	tempDir := filepath.Dir(certPath)

	// Cleanup
	ca.Cleanup()

	// After cleanup, the temp directory should be gone
	if _, err := os.Stat(tempDir); !os.IsNotExist(err) {
		t.Fatalf("Temp CA directory should be removed after Cleanup(): %s still exists", tempDir)
	}

	// Cert path specifically
	if _, err := os.Stat(certPath); !os.IsNotExist(err) {
		t.Fatalf("CA cert should not exist after Cleanup(): %s still exists", certPath)
	}
}

// TestCACleanupIdempotent verifies that calling Cleanup() multiple times is safe.
func TestCACleanupIdempotent(t *testing.T) {
	ca, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("NewCAManager failed: %v", err)
	}

	ca.Cleanup()
	ca.Cleanup() // Should not panic or error
}

// TestCANoPersistentDirectory verifies that NO .agent-replay/ca/ directory is created (FR-037).
func TestCANoPersistentDirectory(t *testing.T) {
	// Ensure the persistent path doesn't exist before test
	persistentPath := filepath.Join(".", ".agent-replay", "ca")
	os.RemoveAll(persistentPath) //nolint:errcheck

	ca, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("NewCAManager failed: %v", err)
	}
	defer ca.Cleanup()

	// The persistent .agent-replay/ca/ directory must NOT have been created
	if _, err := os.Stat(persistentPath); !os.IsNotExist(err) {
		t.Fatalf("Persistent CA directory .agent-replay/ca/ must NOT be created: %s exists", persistentPath)
	}
}

// TestCAGetCertificate verifies that dynamic host certificates can be generated (in-memory).
func TestCAGetCertificate(t *testing.T) {
	ca, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("NewCAManager failed: %v", err)
	}
	defer ca.Cleanup()

	cert, err := ca.GetCertificate("api.example.com:443")
	if err != nil {
		t.Fatalf("GetCertificate failed: %v", err)
	}
	if cert == nil {
		t.Fatal("Expected non-nil certificate")
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("Certificate should have DER bytes")
	}
}

// TestCARepeatedRuns verifies that each NewCAManager() creates a distinct temp directory.
func TestCARepeatedRuns(t *testing.T) {
	ca1, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("First NewCAManager failed: %v", err)
	}
	defer ca1.Cleanup()

	ca2, err := proxy.NewCAManager()
	if err != nil {
		t.Fatalf("Second NewCAManager failed: %v", err)
	}
	defer ca2.Cleanup()

	if ca1.CertPath() == ca2.CertPath() {
		t.Fatal("Repeated NewCAManager() calls must produce distinct temp directories")
	}
}
