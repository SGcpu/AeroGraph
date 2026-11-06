# aerograph-replay-core

`aerograph-replay-core` is a high-performance, local-first network interception and replay engine written in Go. It serves as the deterministic caching backbone for AeroGraph, enabling instant replay (<5ms latency, <18ns request matching) and automated fork-and-resume workflows.

---

## Key Features

- **Blazing Fast Matching**: Zero-allocation request matching and hashing via `xxhash64`, matching cached requests in under 18 nanoseconds.
- **Deterministic Cassettes**: Records HTTP/HTTPS interactions into structured, content-addressed cassettes (`.aerograph/cassettes/<runId>.json`).
- **Ephemeral CA Management**: Dynamically generates isolated root CA certificates per run. Injects proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`) and safely tears them down on exit without leaving untrusted certificates in the system store.
- **Selective Live Passthrough**: Supports `--live-hosts` and `--override-file` to let side-effecting services (payment gateways, webhooks) run live while caching deterministic model completions.
- **Zero External Dependencies**: Standalone compiled binary with no runtime runtime or daemon dependencies.

---

## Building

### Prerequisites
- **Go**: ≥ 1.21

### Compile Binary

```bash
# From repository root:
cd packages/replay-core

# Windows:
go build -o bin/aerograph-replay-core.exe main.go

# Linux / macOS:
go build -o bin/aerograph-replay-core main.go

# Or using Makefile:
make build
```

Verify the compiled binary:
```bash
./bin/aerograph-replay-core --version
```

---

## CLI Usage

```bash
aerograph-replay-core <command> [flags]
```

### Commands

#### `record`
Start MITM proxy in record mode, writing intercepted request-response pairs to the specified cassette:

```bash
aerograph-replay-core record \
  --port 8080 \
  --cassette .aerograph/cassettes/run-123.json \
  --ca-cert .aerograph/certs/ca.crt \
  --ca-key .aerograph/certs/ca.key
```

#### `replay`
Start MITM proxy in replay mode, serving matched requests from the cassette:

```bash
aerograph-replay-core replay \
  --port 8080 \
  --cassette .aerograph/cassettes/run-123.json \
  --live-hosts "api.stripe.com,hooks.slack.com" \
  --override-file overrides.json
```

---

## Flags & Options

| Flag | Type | Description |
|---|---|---|
| `--port` | int | Port to listen on (default: `8080`) |
| `--cassette` | string | Path to the cassette JSON file (required) |
| `--live-hosts` | string | Comma-separated list of hostnames allowed to bypass cache and execute live |
| `--override-file` | string | Path to JSON file specifying mock response overrides for targeted endpoints |
| `--ca-cert` | string | Path to PEM-encoded root CA certificate |
| `--ca-key` | string | Path to PEM-encoded root CA private key |
| `--version` | bool | Print binary version and exit |

---

## Cassette Format

Cassettes are stored in JSON format containing serialized HTTP exchanges:

```json
{
  "version": "1.0.0",
  "metadata": {
    "runId": "run-abc-123",
    "createdAt": "2026-09-05T00:00:00.000Z",
    "totalInteractions": 4
  },
  "interactions": [
    {
      "id": "int-1",
      "request": {
        "method": "POST",
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": { "content-type": ["application/json"] },
        "body": "{\"model\":\"gpt-4o\",\"messages\":[...]}"
      },
      "response": {
        "statusCode": 200,
        "headers": { "content-type": ["application/json"] },
        "body": "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Hello!\"}}]}",
        "durationMs": 340
      }
    }
  ]
}
```

---

## Safety & Security Policies

`aerograph-replay-core` strictly enforces safety policies defined in `aerograph.replay.yaml`:
- **Outbound Restrictions**: Non-whitelisted hosts during replay fail fast with HTTP `502 Bad Gateway` rather than leaking unexpected external traffic.
- **Ephemeral Trust**: Root certificates are created in memory/isolated scratch paths and never installed to the system-wide root trust store, preventing privilege escalation or persistent vulnerabilities.

For full architecture details, refer to:
- [Safety Policy Guide](../../docs/replay/safety-policy.md)
- [Windows Setup & Notes](../../docs/replay/windows-setup.md)
- [Replay Getting Started](../../docs/replay/getting-started.md)
