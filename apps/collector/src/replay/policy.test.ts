import { describe, expect, it } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { loadPolicy, computeLiveHosts, evaluateRequest } from "./policy";
import type { ToolSafetyPolicy } from "@aerograph/contracts";

describe("ToolSafetyPolicy Engine (T063)", () => {
  it("extracts must_execute host patterns in computeLiveHosts", () => {
    const policy: ToolSafetyPolicy = {
      tools: [
        { match: "https://api.openai.com/*", class: "replay_safe" },
        { match: "https://api.github.com/*", class: "must_execute" },
        { match: "https://*.stripe.com/*", class: "must_execute" },
        { match: "slack.com/api/*", class: "must_execute" }
      ]
    };

    const hosts = computeLiveHosts(policy);
    expect(hosts).toContain("api.github.com");
    expect(hosts).toContain("*.stripe.com");
    expect(hosts).toContain("slack.com");
    expect(hosts).not.toContain("api.openai.com");
  });

  it("evaluates rules with first-match semantics and default-denies to must_execute", () => {
    const policy: ToolSafetyPolicy = {
      tools: [
        { match: "https://api.openai.com/v1/models", class: "must_execute" },
        { match: "https://api.openai.com/*", class: "replay_safe" }
      ]
    };

    // First rule matches
    expect(evaluateRequest("https://api.openai.com/v1/models", undefined, policy)).toBe("must_execute");

    // Second rule matches
    expect(evaluateRequest("https://api.openai.com/v1/chat/completions", undefined, policy)).toBe("replay_safe");

    // Unclassified defaults to must_execute
    expect(evaluateRequest("https://unclassified.example.com/api", undefined, policy)).toBe("must_execute");
  });

  it("throws actionable error when aerograph.replay.yaml is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afr_policy_missing_"));
    expect(() => loadPolicy(tempDir)).toThrow(/Missing aerograph\.replay\.yaml/);
    fs.rmdirSync(tempDir);
  });

  it("throws actionable error when aerograph.replay.yaml is malformed YAML", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afr_policy_malformed_"));
    fs.writeFileSync(path.join(tempDir, "aerograph.replay.yaml"), "tools:\n  - match: [invalid yaml");
    expect(() => loadPolicy(tempDir)).toThrow(/Malformed YAML/);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
