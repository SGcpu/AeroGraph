import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export interface AerographProjectConfig {
  version: string;
  command: string[];
  collectorUrl?: string;
  orchestratorUrl?: string;
  projectRoot: string;
}

export function findProjectConfigPath(cwd: string = process.cwd()): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const dotPath = path.join(currentDir, ".aerograph", "aerograph.project.yaml");
    const rootPath = path.join(currentDir, "aerograph.project.yaml");
    if (fs.existsSync(dotPath) && fs.existsSync(rootPath)) {
      try {
        const dotParsed = yaml.load(fs.readFileSync(dotPath, "utf-8")) as any;
        const rootParsed = yaml.load(fs.readFileSync(rootPath, "utf-8")) as any;
        const dotHasScript = Array.isArray(dotParsed?.command) && dotParsed.command.some((a: string) => {
          const ext = path.extname(a).toLowerCase();
          return [".py", ".ts", ".js", ".mjs", ".cjs"].includes(ext) && fs.existsSync(path.resolve(currentDir, a));
        });
        const rootHasScript = Array.isArray(rootParsed?.command) && rootParsed.command.some((a: string) => {
          const ext = path.extname(a).toLowerCase();
          return [".py", ".ts", ".js", ".mjs", ".cjs"].includes(ext) && fs.existsSync(path.resolve(currentDir, a));
        });
        if (rootHasScript && !dotHasScript) {
          return rootPath;
        }
      } catch {}
      return dotPath;
    }
    if (fs.existsSync(dotPath)) return dotPath;
    if (fs.existsSync(rootPath)) return rootPath;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

/**
 * Searches upward from cwd to locate aerograph.project.yaml or .aerograph/aerograph.project.yaml.
 * Throws actionable message if not found.
 */
export function loadProjectConfig(cwd: string = process.cwd()): AerographProjectConfig {
  const configPath = findProjectConfigPath(cwd);
  if (configPath) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = yaml.load(content) as any;

      if (!parsed || typeof parsed !== "object") {
        throw new Error(`Malformed project configuration at ${configPath}`);
      }
      if (!parsed.command || !Array.isArray(parsed.command) || parsed.command.length === 0) {
        throw new Error(`Configuration at ${configPath} must specify a non-empty 'command' array`);
      }

      const projectRoot = path.dirname(configPath.includes(".aerograph") ? path.dirname(configPath) : configPath);
      const command = parsed.command.map((arg: string) => {
        const ext = path.extname(arg).toLowerCase();
        if ([".py", ".ts", ".js", ".mjs", ".cjs"].includes(ext) && !fs.existsSync(path.resolve(projectRoot, arg))) {
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
        }
        return arg;
      });

      return {
        version: parsed.version || "1.0.0",
        command,
        collectorUrl: parsed.collectorUrl || process.env.VITE_COLLECTOR_URL || "http://127.0.0.1:4317",
        orchestratorUrl: parsed.orchestratorUrl || process.env.VITE_ORCHESTRATOR_URL || "http://127.0.0.1:4318",
        projectRoot
      };
    } catch (err: any) {
      throw new Error(`Error reading project configuration at ${configPath}: ${err.message}`);
    }
  }

  throw new Error("No agent command configured. Set a command via 'npx aerorepl config set <command>' or create .aerograph/aerograph.project.yaml.");
}

/**
 * Saves project configuration into .aerograph/aerograph.project.yaml
 */
export function saveProjectConfig(
  command: string[],
  cwd: string = process.cwd(),
  extra: Partial<AerographProjectConfig> = {}
): string {
  const root = path.resolve(cwd);
  const dotAerograph = path.join(root, ".aerograph");
  if (!fs.existsSync(dotAerograph)) {
    fs.mkdirSync(dotAerograph, { recursive: true });
  }
  const configPath = path.join(dotAerograph, "aerograph.project.yaml");
  const data = {
    version: extra.version || "1.0.0",
    command,
    ...(extra.collectorUrl ? { collectorUrl: extra.collectorUrl } : {}),
    ...(extra.orchestratorUrl ? { orchestratorUrl: extra.orchestratorUrl } : {})
  };
  fs.writeFileSync(configPath, yaml.dump(data), "utf-8");
  return configPath;
}

/**
 * Finds aerograph.replay.yaml in the project directory or parent directories.
 */
export function findReplayPolicyPath(cwd: string = process.cwd()): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const policyPath = path.join(currentDir, "aerograph.replay.yaml");
    const dotPolicyPath = path.join(currentDir, ".aerograph", "aerograph.replay.yaml");
    if (fs.existsSync(policyPath)) return policyPath;
    if (fs.existsSync(dotPolicyPath)) return dotPolicyPath;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

/**
 * Saves tool safety policy configuration into aerograph.replay.yaml
 */
export function saveReplayPolicyConfig(content: any, cwd: string = process.cwd()): string {
  const root = path.resolve(cwd);
  const policyPath = path.join(root, "aerograph.replay.yaml");
  const yamlStr = typeof content === "string" ? content : yaml.dump(content);
  fs.writeFileSync(policyPath, yamlStr, "utf-8");
  return policyPath;
}

export interface SaveYamlResult {
  savedFiles: string[];
  types: ("project" | "policy")[];
}

/**
 * Auto-detects whether raw YAML is aerograph.project.yaml, aerograph.replay.yaml, or both,
 * and saves each to its proper location.
 */
export function saveYamlAutoDetect(rawYaml: string, cwd: string = process.cwd()): SaveYamlResult {
  const parsed = yaml.load(rawYaml) as any;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid YAML: content must parse to an object");
  }

  const result: SaveYamlResult = { savedFiles: [], types: [] };

  if (parsed.tools && Array.isArray(parsed.tools)) {
    const policyPath = saveReplayPolicyConfig(parsed, cwd);
    result.savedFiles.push(policyPath);
    result.types.push("policy");
  }

  if (parsed.command) {
    const cmd = Array.isArray(parsed.command)
      ? parsed.command
      : String(parsed.command).trim().split(/\s+/);
    const projPath = saveProjectConfig(cmd, cwd, parsed);
    result.savedFiles.push(projPath);
    result.types.push("project");
  }

  if (result.savedFiles.length === 0) {
    throw new Error(
      "Unrecognized YAML configuration. It must contain either 'command: [...]' (for aerograph.project.yaml) or 'tools: [...]' (for aerograph.replay.yaml)."
    );
  }

  return result;
}
