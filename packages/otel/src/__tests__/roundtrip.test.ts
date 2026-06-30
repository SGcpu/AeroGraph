import { describe, it, expect } from "vitest";
import { exportEventToOtlpSpan } from "../export.js";
import { importOtlpSpanToEvent } from "../import.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { TraceEvent } from "@aerograph/contracts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "../../../../specs/004-otel-bridge/fixtures");
const eventKinds = [
  "prompt", "response", "tool_call", "tool_result", "handoff",
  "error", "note", "retriever", "checkpoint", "state_snapshot"
];

describe("Roundtrip TS: TraceEvent -> OtlpSpan -> TraceEvent", () => {
  const ctx = { traceId: "", defaultActorId: "unknown", preserveOriginalIds: false };

  for (const kind of eventKinds) {
    it(`preserves topology fields for ${kind} event`, () => {
      const fixturePath = path.join(fixturesDir, `${kind}_event.json`);
      const originalEvent = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as TraceEvent;

      const otlpSpan = exportEventToOtlpSpan(originalEvent);
      const importedEvent = importOtlpSpanToEvent(otlpSpan, ctx);

      expect(importedEvent.traceId).toBe(originalEvent.traceId);
      expect(importedEvent.spanId).toBe(originalEvent.spanId);
      expect(importedEvent.parentSpanId).toBe(originalEvent.parentSpanId);
      expect(importedEvent.kind).toBe(originalEvent.kind);
      expect(importedEvent.actor.id).toBe(originalEvent.actor.id);
      expect(importedEvent.actor.kind).toBe(originalEvent.actor.kind);
      expect(importedEvent.status).toBe(originalEvent.status);
      expect(importedEvent.occurredAt).toBe(originalEvent.occurredAt);
      expect(importedEvent.links).toEqual(originalEvent.links || []);
    });
  }

  it("preserves canonical metadata (model, usage, durationMs, projectId, environment)", () => {
    const fullEvent: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "aae19b7ec3c1b175",
      parentSpanId: "eee19b7ec3c1b174",
      occurredAt: "2026-04-15T10:00:00.000Z",
      kind: "response",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      links: [],
      projectId: "proj-123",
      environment: "production",
      durationMs: 1542,
      payload: {
        text: "Here is the answer.",
        model: {
          name: "gpt-4-turbo",
          provider: "openai"
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30
        }
      }
    };

    const span = exportEventToOtlpSpan(fullEvent);
    const imported = importOtlpSpanToEvent(span, ctx);

    expect(imported.projectId).toBe("proj-123");
    expect(imported.environment).toBe("production");
    expect(imported.durationMs).toBe(1542);
    expect(imported.payload).toEqual(fullEvent.payload);
  });
});
