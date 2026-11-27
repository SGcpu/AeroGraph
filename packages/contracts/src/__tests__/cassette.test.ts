import { describe, expect, it } from "vitest";
import {
  cassetteEntrySchema,
  cassetteSchema,
  validateCassette,
  validateCassetteEntry
} from "../cassette";

describe("contracts: cassette schemas", () => {
  const validEntry = {
    requestKey: "k_abc123",
    method: "POST",
    normalizedUrl: "https://api.openai.com/v1/chat/completions",
    requestBodyHash: "hash_body_456",
    responseStatus: 200,
    responseHeaders: { "content-type": "text/event-stream" },
    responseChunks: ["data: chunk1\n\n", "data: chunk2\n\n"],
    streamingPreserved: true,
    recordedAt: "2026-09-01T12:00:00.000Z",
    correlatedSpanId: "s-span-1"
  };

  const validCassette = {
    cassetteVersion: "1.0.0",
    runId: "run-123",
    traceId: "t-abc",
    command: ["python", "agent.py"],
    recordedAt: "2026-09-01T12:00:00.000Z",
    entries: [validEntry]
  };

  it("validates a valid cassette entry", () => {
    const parsed = validateCassetteEntry(validEntry);
    expect(parsed.requestKey).toBe("k_abc123");
    expect(parsed.streamingPreserved).toBe(true);
    expect(parsed.responseChunks).toHaveLength(2);
    expect(parsed.correlatedSpanId).toBe("s-span-1");
  });

  it("accepts null correlatedSpanId in entry", () => {
    const entryWithoutSpan = { ...validEntry, correlatedSpanId: null };
    const parsed = validateCassetteEntry(entryWithoutSpan);
    expect(parsed.correlatedSpanId).toBeNull();
  });

  it("rejects entry missing required fields", () => {
    const invalid = { ...validEntry } as any;
    delete invalid.requestKey;
    expect(() => validateCassetteEntry(invalid)).toThrow();
  });

  it("rejects non-array responseChunks", () => {
    const invalid = { ...validEntry, responseChunks: "not-an-array" } as any;
    expect(() => validateCassetteEntry(invalid)).toThrow();
  });

  it("validates a complete cassette", () => {
    const parsed = validateCassette(validCassette);
    expect(parsed.cassetteVersion).toBe("1.0.0");
    expect(parsed.runId).toBe("run-123");
    expect(parsed.entries).toHaveLength(1);
  });

  it("validates a v2.0.0 cassette with inbound and localRetrievals", () => {
    const v2 = {
      ...validCassette,
      cassetteVersion: "2.0.0" as const,
      inbound: [{ channel: "stdin" as const, turn: 0, prompt: "You: ", payload: "hello" }],
      localRetrievals: [
        { provider: "chromadb" as const, queryKey: "qk_1", result: { documents: [["doc1"]] } }
      ]
    };
    const parsed = validateCassette(v2);
    expect(parsed.cassetteVersion).toBe("2.0.0");
    expect(parsed.inbound).toHaveLength(1);
    expect(parsed.localRetrievals).toHaveLength(1);
  });

  it("rejects invalid cassetteVersion", () => {
    const invalid = { ...validCassette, cassetteVersion: "99.0.0" } as any;
    expect(() => validateCassette(invalid)).toThrow();
  });
});
