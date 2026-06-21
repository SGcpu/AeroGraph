/**
 * @aerograph/otel — Public API
 *
 * AeroGraph → OTLP export bridge.
 * Deterministic, contract-first, no runtime OTel SDK dependency.
 */

// Export functions
export { exportEventToOtlpSpan, exportEventsToOtlp } from "./export.js";
export type { ExportOptions } from "./export.js";

// OTLP schema and types
export {
  otlpExportRequestSchema,
  otlpSpanSchema,
  otlpAttributeSchema,
  otlpLinkSchema,
} from "./otlp-schema.js";
export type { OtlpExportRequest, OtlpSpan, OtlpAttribute, OtlpLink, OtlpAnyValue } from "./otlp-schema.js";

// Attribute key constants
export { AEROGRAPH_ATTRS } from "./constants.js";
export type { AerographAttrKey } from "./constants.js";
// Import functions
export { importOtlpSpanToEvent, importOtlpToEvents } from "./import.js";
export type { MappingContext } from "./import.js";

// Timestamp utilities
export { isoToUnixNano, unixNanoToIso } from "./timestamp.js";

// Mapping utilities (exported for advanced use / testing)
export {
  getSpanNameForKind,
  getSpanKindInt,
  buildAttributesFromEvent,
  exportLinksToOtlp,
  SPAN_KIND,
  STATUS_CODE,
} from "./mapping.js";

// Semantic Mapping (GenAI Conventions)
export {
  GEN_AI_ATTRS,
  COMMON_ATTRS,
  mapCanonicalTelemetry,
  mapModelTelemetry,
  mapUsageTelemetry,
} from "./semantic_mapping.js";
