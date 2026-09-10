import fs from "fs";
import path from "path";

const SCRIPT_EXTENSIONS = new Set([".py", ".ts", ".js", ".mjs", ".cjs", ".sh", ".bash", ".ps1"]);

/**
 * Checks if a command argument looks like a script file path based on extension.
 */
export function isScriptFile(arg: string): boolean {
  if (!arg || arg.startsWith("-")) return false;
  const ext = path.extname(arg).toLowerCase();
  return SCRIPT_EXTENSIONS.has(ext);
}

/**
 * Returns true if at least one script argument in the command exists on disk relative to projectRoot.
 */
export function commandHasExistingScript(command: string[], projectRoot: string): boolean {
  if (!command || !Array.isArray(command) || command.length === 0) return false;
  for (const arg of command) {
    if (isScriptFile(arg)) {
      if (fs.existsSync(path.resolve(projectRoot, arg))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves script paths within a command. If an argument is a script that does NOT exist
 * directly in projectRoot, scans common project locations (e.g. examples/openrouter-langgraph-py)
 * and replaces the argument with the relative path to the existing file.
 */
export function resolveCommandScriptPaths(command: string[], projectRoot: string): string[] {
  if (!command || !Array.isArray(command) || command.length === 0) return command;

  return command.map((arg) => {
    if (!isScriptFile(arg)) {
      return arg;
    }

    // If it already exists directly in projectRoot, keep it
    if (fs.existsSync(path.resolve(projectRoot, arg))) {
      return arg;
    }

    const filename = path.basename(arg);
    const candidateSubdirs = [
      path.join("examples", "openrouter-langgraph-py"),
      path.join("examples", "openrouter-langgraph-ts"),
      path.join("examples"),
      path.join("tests", "fixtures"),
      path.join("src")
    ];

    for (const subdir of candidateSubdirs) {
      const candidateRelative = path.join(subdir, filename);
      if (fs.existsSync(path.resolve(projectRoot, candidateRelative))) {
        return candidateRelative.replace(/\\/g, "/");
      }
    }

    // Try scanning one level deep in examples/*
    try {
      const examplesDir = path.resolve(projectRoot, "examples");
      if (fs.existsSync(examplesDir)) {
        const entries = fs.readdirSync(examplesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const nested = path.join("examples", entry.name, filename);
            if (fs.existsSync(path.resolve(projectRoot, nested))) {
              return nested.replace(/\\/g, "/");
            }
          }
        }
      }
    } catch {
      // Non-blocking fallback
    }

    return arg;
  });
}
