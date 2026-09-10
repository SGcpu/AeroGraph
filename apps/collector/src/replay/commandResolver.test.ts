import { describe, it, expect } from "vitest";
import path from "path";
import { isScriptFile, commandHasExistingScript, resolveCommandScriptPaths } from "./commandResolver";

describe("commandResolver", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");

  it("identifies script files accurately", () => {
    expect(isScriptFile("agent.py")).toBe(true);
    expect(isScriptFile("agent.ts")).toBe(true);
    expect(isScriptFile("agent.js")).toBe(true);
    expect(isScriptFile("script.sh")).toBe(true);
    expect(isScriptFile("--foo")).toBe(false);
    expect(isScriptFile("python")).toBe(false);
    expect(isScriptFile("node")).toBe(false);
  });

  it("checks whether a command has an existing script in projectRoot", () => {
    expect(commandHasExistingScript(["python", "agent.py"], repoRoot)).toBe(false);
    expect(commandHasExistingScript(["python", "examples/openrouter-langgraph-py/agent.py"], repoRoot)).toBe(true);
  });

  it("resolves script path when agent.py is in examples/", () => {
    const resolved = resolveCommandScriptPaths(["python", "agent.py"], repoRoot);
    expect(resolved).toEqual(["python", "examples/openrouter-langgraph-py/agent.py"]);
  });

  it("leaves already existing paths unchanged", () => {
    const original = ["python", "examples/openrouter-langgraph-py/agent.py"];
    const resolved = resolveCommandScriptPaths(original, repoRoot);
    expect(resolved).toEqual(original);
  });

  it("leaves non-script commands unchanged", () => {
    const cmd = ["npm", "run", "start"];
    expect(resolveCommandScriptPaths(cmd, repoRoot)).toEqual(cmd);
  });
});
