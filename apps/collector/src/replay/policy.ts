import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  validateToolSafetyPolicy,
  type ToolSafetyPolicy
} from "@aerograph/contracts";

/**
 * Loads and validates aerograph.replay.yaml from the project root.
 * Throws actionable errors if missing or malformed per FR-024.
 */
export function loadPolicy(projectRoot: string): ToolSafetyPolicy {
  const policyPath = path.resolve(projectRoot, "aerograph.replay.yaml");

  if (!fs.existsSync(policyPath)) {
    throw new Error(
      `Missing aerograph.replay.yaml in ${projectRoot}. Replay and fork require an explicit tool safety policy (FR-024). Create aerograph.replay.yaml to declare replay_safe and must_execute tools.`
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(policyPath, "utf-8");
  } catch (err: any) {
    throw new Error(`Failed to read aerograph.replay.yaml at ${policyPath}: ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err: any) {
    throw new Error(`Malformed YAML in aerograph.replay.yaml at ${policyPath}: ${err.message}`);
  }

  try {
    return validateToolSafetyPolicy(parsed);
  } catch (err: any) {
    throw new Error(`Invalid schema in aerograph.replay.yaml at ${policyPath}: ${err.message}`);
  }
}

/**
 * Extracts unique live host patterns from must_execute rules for passing to --live-hosts.
 */
export function computeLiveHosts(policy: ToolSafetyPolicy): string[] {
  const liveHosts = new Set<string>();

  for (const rule of policy.tools) {
    if (rule.class === "must_execute") {
      const host = extractHostFromPattern(rule.match);
      if (host) {
        liveHosts.add(host);
      }
    }
  }

  return Array.from(liveHosts);
}

function extractHostFromPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes("://")) {
      // Replace wildcards so URL constructor doesn't fail
      const sanitized = trimmed.replace(/\*/g, "wildcard");
      const url = new URL(sanitized);
      const host = url.host || url.hostname;
      return host.replace(/wildcard/g, "*");
    }

    // No protocol specified (e.g. "api.github.com/*")
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      return trimmed.slice(0, slashIdx);
    }
    return trimmed;
  } catch {
    const parts = trimmed.split("/");
    return parts[0] || null;
  }
}

/**
 * Evaluates an outbound request against the tool safety policy using first-match semantics.
 * Defaults to "must_execute" if no rule matches (default-deny for safety per FR-022).
 */
export function evaluateRequest(
  url: string,
  toolName: string | undefined,
  policy: ToolSafetyPolicy
): "replay_safe" | "must_execute" {
  for (const rule of policy.tools) {
    if (rule.toolName && toolName && rule.toolName === toolName) {
      return rule.class;
    }
    if (matchUrlPattern(rule.match, url)) {
      return rule.class;
    }
  }
  return "must_execute";
}

export function matchUrlPattern(pattern: string, urlStr: string): boolean {
  if (pattern === "*") return true;
  const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  const regex = new RegExp(regexStr);
  return regex.test(urlStr);
}

/**
 * Logs a routing decision to the trace store as a span annotation.
 */
export function logRoutingDecision(
  store: any,
  traceId: string,
  spanId: string,
  decision: {
    decision: string;
    matchedPattern?: string | null;
    effectiveClass?: string | null;
  }
): void {
  store.appendReplayAnnotation(traceId, spanId, decision);
}

