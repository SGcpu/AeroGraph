# Windows Setup & Best Practices for Deterministic Replay

This document details platform-specific guidance for developers running AeroGraph Deterministic Replay on Windows systems.

## Prerequisites & Installation

### 1. Go Runtime
Ensure Go >= 1.22 is installed:
```powershell
winget install GoLang.Go
# Or via Chocolatey:
choco install golang
```
Verify via `go version`.

### 2. TLS Interception Trust (mkcert)
`aerograph-replay-core` generates an ephemeral local CA certificate for the duration of each replay/record session. To enable seamless HTTPS interception:
```powershell
choco install mkcert
mkcert -install
```
On exit, `aerograph-replay-core` automatically uninstalls the ephemeral CA and wipes all private key material from disk (FR-037).

## Windows Defender & Firewall Considerations

When `aerograph-replay-core` binds to the local loopback port (default `127.0.0.1:8080`), Windows Defender or Firewall may display a one-time network authorization prompt.
- Choose **Allow access** on private networks.
- The proxy strictly binds to `127.0.0.1` (loopback only) and does not listen on external network interfaces.

## PowerShell Command Quoting with `aerorepl`

When invoking `aerorepl record` in PowerShell (`pwsh`), remember that PowerShell parses semicolons (`;`) and ampersands (`&`) as command separators. If your agent invocation contains special shell characters or json strings, quote them:

```powershell
# Standard usage:
aerorepl record python agent.py

# In the interactive REPL session:
aerorepl session <runId>

# Passing JSON to /override:
# Use single quotes around the JSON argument in PowerShell:
aerorepl> /override span-123 '{"promptText": "What is deterministic replay?"}'
```
