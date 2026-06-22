/**
 * packages/otel/src/export.ts
 *
 * AeroGraph TraceEvent → OTLP span/request conversion.
 *
 * Functions:
 *   exportEventToOtlpSpan(event)         — single TraceEvent → OtlpSpan
 *   exportEventsToOtlp(events, options?) — TraceEvent[] → OtlpExportRequest
 *
 * Rules:
 *   - Deterministic: same input always produces same output
 *   - traceId, spanId, parentSpanId passed through unchanged (hex format preserved)
 *   - occurredAt → startTimeUnixNano; endTimeUnixNano = startTimeUnixNano + 1ms
 *   - status: "ok" → code 1, "error" → code 2
 *   - links preserved as OtlpLink[] with aerograph.link.rel attribute
 *
 * Mirrors export.py in Python exactly.
 */

import type { TraceEvent } from "@aerograph/contracts";
import { sortTraceEventsDeterministic } from "@aerograph/contracts";
import { isoToUnixNano } from "./timestamp.js";
import { buildAttributesFromEvent, exportLinksToOtlp, getSpanKindInt, getSpanNameForKind, STATUS_CODE } from "./mapping.js";
import { mapCanonicalTelemetry, mapModelTelemetry, mapUsageTelemetry } from "./semantic_mapping.js";
import type { OtlpExportRequest, OtlpSpan } from "./otlp-schema.js";
import { createHash } from "crypto";

const PACKAGE_VERSION = "0.1.1";
const ONE_MS_IN_NS = 1_000_000n;

/**
 * Normalize any AeroGraph ID to a valid OTLP hex string.
 *
 * OTLP strictly requires:
 *   - traceId: 32 lowercase hex chars (16 bytes)
 *   - spanId:  16 lowercase hex chars (8 bytes)
 *
 * AeroGraph uses human-readable prefixed IDs like `t_<base64url>` or `s_<base64url>`.
 * This function deterministically maps any such ID to the correct hex length via SHA-256
 * so that the same input always produces the same output (roundtrip-stable).
 *
 * @param id     The AeroGraph ID string (e.g. "t_abc123" or "s_xyz789")
 * @param bytes  16 for traceId, 8 for spanId
 */
function toOtlpHex(id: string, bytes: 16 | 8): string {
  // If already a valid hex string of the right length, pass through unchanged.
  const expectedLen = bytes * 2;
  if (/^[0-9a-f]+$/i.test(id) && id.length === expectedLen) {
    return id.toLowerCase();
  }
  // Otherwise, deterministically derive a hex string via SHA-256 truncation.
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, expectedLen);
}

export interface ExportOptions {
  /** Service name to use in the OTLP resource attributes. Default: "aerograph-agent" */
  serviceName?: string;
  /** Instrumentation scope name. Default: "@aerograph/otel" */
  scopeName?: string;
  /** Instrumentation scope version. Default: package version */
  scopeVersion?: string;
}

/**
 * Export a single AeroGraph TraceEvent to an OTLP-compatible span structure.
 * Deterministic: same input always produces the same output.
 */
export function exportEventToOtlpSpan(event: TraceEvent): OtlpSpan {
  const startNano = isoToUnixNano(event.occurredAt);
  const durationNano = event.durationMs !== undefined 
    ? BigInt(Math.floor(event.durationMs * 1_000_000)) 
    : ONE_MS_IN_NS;
  const endNano = (BigInt(startNano) + durationNano).toString();

  const span: OtlpSpan = {
    traceId: toOtlpHex(event.traceId, 16),
    spanId: toOtlpHex(event.spanId, 8),
    name: getSpanNameForKind(event.kind),
    kind: getSpanKindInt(event.kind),
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    status: {
      code: event.status === "ok" ? STATUS_CODE.OK : STATUS_CODE.ERROR,
      ...(event.status === "error" && event.kind === "error"
        ? { message: (event.payload as { message: string }).message }
        : {}),
    },
    attributes: [
      ...buildAttributesFromEvent(event),
      ...mapCanonicalTelemetry(event),
      ...mapModelTelemetry(event),
      ...mapUsageTelemetry(event),
    ],
    links: exportLinksToOtlp(event.links, event.traceId),
  };

  // parentSpanId: only include if not null
  if (event.parentSpanId !== null) {
    span.parentSpanId = toOtlpHex(event.parentSpanId, 8);
  }

  return span;
}

/**
 * Export an array of TraceEvents to a complete OtlpExportRequest envelope.
 * Events are sorted deterministically before export.
 */
export function exportEventsToOtlp(
  events: TraceEvent[],
  options: ExportOptions = {}
): OtlpExportRequest {
  const {
    serviceName = "aerograph-agent",
    scopeName = "@aerograph/otel",
    scopeVersion = PACKAGE_VERSION,
  } = options;

  const sorted = sortTraceEventsDeterministic(events);
  const spans = sorted.map(exportEventToOtlpSpan);

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: serviceName },
            },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: scopeName,
              version: scopeVersion,
            },
            spans,
          },
        ],
      },
    ],
  };
}
