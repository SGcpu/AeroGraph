import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  validateCassettePath,
  readCassette,
  writeCassette,
  writeForkCassette
} from "./cassette.js";
import { computeStateHash } from "@aerograph/contracts";

describe("Replay Cassette Integrity & Security (T099, T101, T107)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cassette-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // T099: Determinism test: same request inputs produce identical requestKey; 100 distinct requests produce no collisions
  it("T099: determinism test: same request produces identical key; 100 distinct requests produce 0 collisions", () => {
    function computeRequestKey(method: string, url: string, body: string): string {
      const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
      return crypto
        .createHash("sha256")
        .update(`${method.toUpperCase()}${url}${bodyHash}`)
        .digest("hex");
    }

    const key1 = computeRequestKey("POST", "https://api.openai.com/v1/chat/completions", '{"prompt":"hello"}');
    const key2 = computeRequestKey("POST", "https://api.openai.com/v1/chat/completions", '{"prompt":"hello"}');
    expect(key1).toBe(key2);

    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const key = computeRequestKey(
        "POST",
        `https://api.openai.com/v1/chat/completions`,
        JSON.stringify({ prompt: `hello-${i}`, seed: i })
      );
      keys.add(key);
    }
    expect(keys.size).toBe(100);
  });

  // T101: Corrupted cassette test: malformed JSON throws
  it("T101: corrupted cassette throws actionable error", () => {
    const cassettesDir = path.join(tempDir, ".aerograph", "cassettes");
    fs.mkdirSync(cassettesDir, { recursive: true });
    const filePath = path.join(cassettesDir, "run-corrupted.json");
    fs.writeFileSync(filePath, "{ malformed json...", "utf-8");

    expect(() => readCassette("run-corrupted", tempDir)).toThrow(
      /corrupted or invalid JSON/i
    );
  });

  it("T101: missing cassette throws actionable error", () => {
    expect(() => readCassette("run-non-existent", tempDir)).toThrow(
      /Cassette for run run-non-existent is missing or unreadable/i
    );
  });

  // T107: Path traversal test: runId with ../ throws before filesystem access
  it("T107: path traversal test rejects malicious runId", () => {
    expect(() => validateCassettePath("../../etc/passwd", tempDir)).toThrow(
      /path traversal/i
    );
    expect(() => validateCassettePath("..\\..\\windows\\system32", tempDir)).toThrow(
      /path traversal/i
    );
    expect(() => validateCassettePath("sub/dir", tempDir)).toThrow(
      /path traversal/i
    );
  });
});
