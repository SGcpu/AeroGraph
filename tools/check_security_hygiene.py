#!/usr/bin/env python3
"""
AeroGraph Security & Credential Hygiene Scanner
Enforces Constitution Principle VI: Ephemeral Security & Credential Hygiene.

Validates:
1. No unredacted authorization or secret headers in cassettes or recorded fixtures.
2. No private keys (CA keys, SSH/TLS keys) committed to the repository.
3. No raw live LLM API keys committed in source or configuration files.
"""

import os
import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

# Patterns that indicate forbidden secrets in repository files
FORBIDDEN_PATTERNS = [
    (r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----", "Private key detected"),
    (r"sk-proj-[a-zA-Z0-9_-]{30,}", "Live OpenAI project key detected"),
    (r"sk-ant-[a-zA-Z0-9_-]{30,}", "Live Anthropic key detected"),
    (r"sk-or-v1-[a-zA-Z0-9_-]{30,}", "Live OpenRouter key detected"),
]

# Sensitive header patterns in cassettes
CASSETTE_SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "cookie", "set-cookie"]

IGNORED_DIRS = {".git", ".venv", "node_modules", "dist", "build", ".pytest_cache", ".aerograph", ".agent-replay"}
IGNORED_FILES = {
    ".env.example",
    "check_security_hygiene.py",
    "Feature-006-v2_Reality-Check-and-Revised-Approach.md",
}


def scan_file_for_secrets(file_path: Path) -> list[str]:
    violations = []
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return violations

    for pattern, description in FORBIDDEN_PATTERNS:
        matches = re.findall(pattern, content)
        if matches:
            violations.append(f"{file_path}: {description}")

    # If it's a cassette file or fixture, check for unredacted sensitive headers
    if "cassette" in file_path.name.lower() or "cassettes" in [p.lower() for p in file_path.parts]:
        for header in CASSETTE_SENSITIVE_HEADERS:
            # Check for header keys with unredacted values (not [REDACTED] or masked)
            # Example JSON: "authorization": "Bearer secret..."
            matches = re.finditer(rf'"{header}"\s*:\s*"([^"]+)"', content, re.IGNORECASE)
            for m in matches:
                val = m.group(1).strip()
                if val and val != "[REDACTED]" and not val.endswith("[REDACTED]"):
                    violations.append(
                        f"{file_path}: Unredacted sensitive header '{header}' found: '{val[:20]}...'"
                    )

    return violations


def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    print("[SECURITY-SCAN] Running Constitution Principle VI Security Hygiene Scanner...")
    all_violations = []

    for root, dirs, files in os.walk(ROOT_DIR):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for file in files:
            if file in IGNORED_FILES:
                continue
            file_path = Path(root) / file
            # Only scan text-like files
            if file_path.suffix in [".ts", ".tsx", ".js", ".mjs", ".py", ".json", ".yaml", ".yml", ".md", ".env"]:
                violations = scan_file_for_secrets(file_path)
                all_violations.extend(violations)

    if all_violations:
        print("\n❌ SECURITY HYGIENE VIOLATIONS DETECTED:")
        for v in all_violations:
            print(f"  - {v}")
        print("\nPlease redact secrets, sanitize cassettes with '[REDACTED]', and ensure no private keys are committed.")
        sys.exit(1)

    print("[SECURITY-SCAN] [OK] Security & Credential Hygiene Scanner passed. Zero leaked secrets or unredacted cassettes.")
    sys.exit(0)


if __name__ == "__main__":
    main()
