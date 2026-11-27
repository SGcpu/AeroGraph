#!/usr/bin/env node

import { Command } from "commander";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { AereplClient, SessionInfo } from "./client.js";
import {
  loadProjectConfig,
  saveProjectConfig,
  saveYamlAutoDetect,
  findReplayPolicyPath,
  detectVirtualEnv,
  AerographProjectConfig
} from "./config.js";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[1;36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m"
};

function formatModeBadge(mode: string): string {
  if (mode === "replay") return `${c.green}[replay · $0.00]${c.reset}`;
  if (mode === "fork") return `${c.cyan}[fork & resume]${c.reset}`;
  return `${c.magenta}[record]${c.reset}`;
}

function formatStatusBadge(status: string): string {
  if (status === "completed") return `${c.green}✓ completed${c.reset}`;
  if (status === "running" || status === "pending") return `${c.yellow}⟳ ${status}${c.reset}`;
  return `${c.red}✗ ${status}${c.reset}`;
}

function getProjectConfig(): AerographProjectConfig {
  try {
    return loadProjectConfig();
  } catch {
    return {
      version: "1.0.0",
      command: [],
      projectRoot: process.cwd()
    };
  }
}

export async function handleSessionCommand(
  input: string,
  session: SessionInfo,
  client: AereplClient
): Promise<string> {
  const trimmed = input.trim();

  if (trimmed === "/help" || trimmed === "?") {
    return [
      `${c.bold}Interactive Session Commands:${c.reset}`,
      `  ${c.brightCyan}/spans${c.reset}                         List all spans in this trace with their spanIds`,
      `  ${c.brightCyan}/step${c.reset}                          Advance to the next span and show a preview`,
      `  ${c.brightCyan}/inspect <spanId>${c.reset}              Print full JSON payload for a span`,
      `  ${c.brightCyan}/override <spanId> <text|@file>${c.reset} Override prompt text for a span before forking`,
      `  ${c.brightCyan}/rewind <N>${c.reset}                    Rewind N steps and branch a new trace`,
      `  ${c.brightCyan}/fork <spanId> [newPrompt]${c.reset}     Fork & resume from <spanId> (inline prompt optional)`,
      `  ${c.brightCyan}/quit${c.reset}                          Exit the interactive REPL`
    ].join("\n");
  }

  if (trimmed === "/spans") {
    const trace = await client.getTrace(session.traceId);
    const evts = trace?.events || [];
    if (evts.length === 0) {
      return `${c.dim}No spans recorded yet in trace ${session.traceId}.${c.reset}`;
    }
    const lines = [
      `${c.bold}Spans in ${c.cyan}${session.traceId}${c.reset}${c.bold}:${c.reset}`
    ];
    evts.forEach((ev: any, idx: number) => {
      const ovrTag = (session as any).overrides?.[ev.spanId] ? ` ${c.yellow}[OVERRIDDEN]${c.reset}` : "";
      const previewRaw = ev.payload?.text || ev.payload?.query || ev.title || "";
      const preview = String(previewRaw).replace(/\s+/g, " ").slice(0, 48);
      lines.push(
        `  ${c.dim}#${String(idx + 1).padEnd(2)}${c.reset} ${c.cyan}[${ev.kind}]${c.reset} ${c.bold}${ev.spanId}${c.reset}${ovrTag}  ${c.dim}${preview}${previewRaw.length > 48 ? "..." : ""}${c.reset}`
      );
    });
    return lines.join("\n");
  }

  if (trimmed === "/step") {
    const result = await client.stepSession(session.sessionId);
    session.currentStep = result.step;
    if (!result.spanSummary) {
      const runStatus = (session as any).runStatus;
      if (runStatus === "failed" || runStatus === "crashed") {
        return `${c.yellow}Step ${result.step}:${c.reset} No further spans (Run ${session.runId} ended with status '${runStatus}')`;
      }
      return `${c.dim}Step ${result.step}: End of trace (no further spans). Type /quit or /fork <spanId>.${c.reset}`;
    }
    const statusColor = result.spanSummary.status === "error" ? c.red : c.green;
    return `${c.bold}Step ${result.step}:${c.reset} ${c.cyan}[${result.spanSummary.kind}]${c.reset} ${c.bold}${result.spanSummary.spanId}${c.reset} ${statusColor}(${
      result.spanSummary.status || "ok"
    })${c.reset}  ${c.dim}→ /inspect ${result.spanSummary.spanId}${c.reset}`;
  }

  if (trimmed.startsWith("/inspect")) {
    const parts = trimmed.split(/\s+/);
    const spanId = parts[1];
    if (!spanId) return "Error: /inspect requires <spanId>";
    const event = await client.inspectSpan(session.traceId, spanId);
    if (!event) return `Span ${spanId} not found in trace ${session.traceId}`;

    const activeOverride = (session as any).overrides?.[spanId];
    if (activeOverride) {
      const promptText =
        typeof activeOverride === "string"
          ? activeOverride
          : (activeOverride.promptText || activeOverride.payload?.text || JSON.stringify(activeOverride));

      const enrichedEvent: any = {
        ...event,
        override: {
          active: true,
          promptText
        }
      };
      if (enrichedEvent.payload && typeof enrichedEvent.payload === "object") {
        enrichedEvent.payload = {
          ...enrichedEvent.payload,
          text: promptText,
          _originalText: (event.payload as any)?.text
        };
      }
      return JSON.stringify(enrichedEvent, null, 2);
    }

    return JSON.stringify(event, null, 2);
  }

  if (trimmed.startsWith("/override")) {
    const match = trimmed.match(/^\/override\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) return "Error: /override requires <spanId> [json|text|@file]";
    const [, spanId, rawArg] = match;
    const cleanArg = (rawArg || "").trim();

    if (!cleanArg) {
      return "Error: /override requires a replacement prompt text or JSON. Example: /override s_123 \"new prompt text\" or /override s_123 @file.json";
    }

    let value: any;
    if (cleanArg.startsWith("@") || cleanArg.startsWith("--file ")) {
      const filePath = cleanArg.startsWith("@") ? cleanArg.slice(1).trim() : cleanArg.replace(/^--file\s+/, "").trim();
      try {
        const fileContent = fs.readFileSync(path.resolve(filePath), "utf-8").trim();
        try {
          value = JSON.parse(fileContent);
        } catch {
          value = fileContent;
        }
      } catch (fErr: any) {
        return `Error reading file '${filePath}': ${fErr.message}`;
      }
    } else {
      try {
        value = JSON.parse(cleanArg);
      } catch {
        value = cleanArg;
      }
    }

    // If full event was passed, automatically extract prompt payload text
    if (value && typeof value === "object") {
      if (value.payload?.text) {
        value = { promptText: value.payload.text };
      } else if (value.text) {
        value = { promptText: value.text };
      } else if (value.promptText) {
        value = { promptText: value.promptText };
      }
    } else if (typeof value === "string") {
      value = { promptText: value };
    }

    const result = await client.overrideSpan(session.sessionId, spanId, value);
    (session as any).overrides = (session as any).overrides || {};
    (session as any).overrides[spanId] = value;
    const preview = typeof value === "object" ? (value.promptText || JSON.stringify(value)) : String(value);
    return `✓ Overridden span ${result.spanId} with prompt: "${preview.slice(0, 80)}${preview.length > 80 ? '...' : ''}"`;
  }

  if (trimmed.startsWith("/rewind")) {
    const parts = trimmed.split(/\s+/);
    const steps = parts[1] ? parseInt(parts[1], 10) : 1;
    const result = await client.rewindSession(session.sessionId, steps);
    session.traceId = result.newTraceId;
    session.currentStep = result.currentStep;
    return `Rewound to step ${result.currentStep}. New trace ID: ${result.newTraceId}`;
  }

  if (trimmed.startsWith("/fork")) {
    const match = trimmed.match(/^\/fork\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) return "Error: /fork requires <spanId> [optional new prompt]";
    const [, spanId, inlinePrompt] = match;
    const cleanInline = (inlinePrompt || "").trim().replace(/^["']|["']$/g, "");
    if (cleanInline) {
      await client.overrideSpan(session.sessionId, spanId, { promptText: cleanInline });
      (session as any).overrides = (session as any).overrides || {};
      (session as any).overrides[spanId] = { promptText: cleanInline };
    }
    const promptOverride = (session as any).overrides?.[spanId];
    const promptText =
      typeof promptOverride === "string"
        ? promptOverride
        : promptOverride?.promptText || promptOverride?.payload?.text;
    const config = getProjectConfig();
    const result = await client.forkFromSpan(
      session.traceId,
      spanId,
      promptText,
      config.projectRoot,
      config.command && config.command.length > 0 ? config.command : undefined
    );
    const noOverrideNote = !promptText
      ? `\n  ${c.yellow}Note:${c.reset} No prompt override was set — forked with original prompt. Use ${c.brightCyan}/fork ${spanId} "new prompt"${c.reset} to diverge.`
      : `\n  ${c.dim}Override:${c.reset}    "${promptText.slice(0, 70)}${promptText.length > 70 ? "..." : ""}"`;
    return `${c.green}✓ Forked trace${c.reset} ${session.traceId} at ${c.bold}${spanId}${c.reset}` +
      noOverrideNote +
      `\n  Child Trace: ${c.cyan}${result.childTraceId}${c.reset}` +
      `\n  Run ID:      ${c.bold}${result.runId}${c.reset} (${result.status})` +
      `\n  Inspect:     ${c.dim}aerorepl status ${result.runId}  |  http://localhost:5173${c.reset}`;
  }

  return `${c.yellow}Unknown command:${c.reset} ${trimmed}. Type ${c.brightCyan}/help${c.reset} to see available commands.`;
}

export async function renderLandingScreen(
  config: AerographProjectConfig,
  client: AereplClient
): Promise<void> {
  const cyan = "\x1b[36m";
  const brightCyan = "\x1b[1;36m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";
  const dim = "\x1b[90m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  const banner = `
${brightCyan}   ___  ___ ___  ___   ____ ___    _   ___ _  _ 
  / _ \\/ __| _ \\/ _ \\ / ___| _ \\  /_\\ | _ \\ || |
 / /_\\ \\ _| |   / (_) | | _| |   / _ \\|  _/ __ |
/_/   \\_\\___|_|_\\\\___/ \\____|_| /_/ \\_\\_| |_||_|${reset}
${cyan}Flight Recorder for Autonomous AI Workflows${reset} ${dim}· v0.4.5${reset}
`;

  console.log(banner);

  const collectorUrl = client.collectorUrl || config.collectorUrl || "http://localhost:4317";
  const orchestratorUrl = client.orchestratorUrl || config.orchestratorUrl || "http://localhost:4318";

  let collectorOnline = false;
  let orchestratorOnline = false;
  let recentRuns: any[] = [];

  try {
    const colRes = await fetch(`${collectorUrl}/v1/traces`, {
      signal: AbortSignal.timeout(600),
      headers: { Accept: "application/json" }
    });
    if (colRes.ok) collectorOnline = true;
  } catch {}

  try {
    const runs = await client.listRuns();
    orchestratorOnline = true;
    if (Array.isArray(runs)) {
      recentRuns = runs.slice(0, 3);
    }
  } catch {}

  // Check replay binary
  const ext = process.platform === "win32" ? ".exe" : "";
  let binaryFound = false;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const possiblePaths = [
      process.env.AERO_REPLAY_CORE_BIN,
      path.resolve(process.cwd(), "packages", "replay-core", "bin", `aerograph-replay-core${ext}`),
      path.resolve(process.cwd(), "bin", `aerograph-replay-core${ext}`),
      path.resolve(__dirname, "..", "..", "replay-core", "bin", `aerograph-replay-core${ext}`),
      path.resolve(__dirname, "..", "..", "..", "packages", "replay-core", "bin", `aerograph-replay-core${ext}`)
    ].filter(Boolean) as string[];
    binaryFound = possiblePaths.some((p) => fs.existsSync(p));
  } catch {}

  // Check project config
  const projectCmd =
    Array.isArray(config.command) && config.command.length > 0
      ? config.command.join(" ")
      : "Not configured (run 'aerorepl config set <cmd>' to save)";

  const envInfo = detectVirtualEnv(config.projectRoot);
  const envDisplay = envInfo.virtualEnv
    ? `${green}🟢 Detected${reset} (${envInfo.virtualEnv})`
    : `${yellow}⚪ System PATH${reset} (no .venv/conda detected)`;

  const policyPath = findReplayPolicyPath(config.projectRoot);
  let policyDisplay = `${dim}⚪ None (create aerograph.replay.yaml)${reset}`;
  if (policyPath) {
    try {
      const raw = fs.readFileSync(policyPath, "utf-8");
      const parsed = yaml.load(raw) as any;
      const count = Array.isArray(parsed?.tools) ? parsed.tools.length : 0;
      const hasNorm = Boolean(parsed?.normalization);
      policyDisplay = `${green}🟢 Loaded${reset}   (${count} rule${count === 1 ? "" : "s"}${hasNorm ? ", normalization on" : ""})`;
    } catch {
      policyDisplay = `${green}🟢 Loaded${reset}   (${policyPath})`;
    }
  }

  console.log(`${bold}System Health:${reset}`);
  console.log(`${dim}  ────────────────────────────────────────────────────────────────────────${reset}`);
  console.log(
    `  ${dim}●${reset} Collector:     ${
      collectorOnline ? `${green}🟢 Online${reset}  (${collectorUrl})` : `${dim}⚪ Offline${reset} (${collectorUrl})`
    }`
  );
  console.log(
    `  ${dim}●${reset} Orchestrator:  ${
      orchestratorOnline ? `${green}🟢 Online${reset}  (${orchestratorUrl})` : `${dim}⚪ Offline${reset} (${orchestratorUrl})`
    }`
  );
  console.log(
    `  ${dim}●${reset} Replay Proxy:  ${
      binaryFound ? `${green}🟢 Ready${reset}   (aerograph-replay-core${ext})` : `${yellow}🟡 Build needed${reset} (go build in packages/replay-core)`
    }`
  );
  console.log(`  ${dim}●${reset} Python Env:    ${envDisplay}`);
  console.log(`  ${dim}●${reset} Tool Policy:   ${policyDisplay}`);
  console.log(`  ${dim}●${reset} Project Agent: ${cyan}${projectCmd}${reset}`);

  if (recentRuns.length > 0) {
    console.log(`\n${bold}Recent Executions:${reset}`);
    console.log(`${dim}  ────────────────────────────────────────────────────────────────────────${reset}`);
    for (const r of recentRuns) {
      const statusIcon = r.status === "completed" ? `${green}✓${reset}` : `${yellow}⚠${reset}`;
      const modeBadge = formatModeBadge(r.mode);
      const dateStr = r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : "";
      console.log(`  ${statusIcon} ${bold}${r.runId}${reset} ${modeBadge} ${dim}${r.command?.join(" ") || ""} (${dateStr})${reset}`);
    }
  }

  const latestRunId = recentRuns[0]?.runId || "<runId>";
  const latestTraceId = recentRuns[0]?.traceId || "<traceId>";
  if (!collectorOnline || !orchestratorOnline) {
    console.log(`\n${yellow}Tip:${c.reset} Start local services with ${brightCyan}npm run dev${reset} to enable recording, replay, and Web UI.`);
  }

  console.log(`\n${bold}Quick Commands:${reset}`);
  console.log(`${dim}  ────────────────────────────────────────────────────────────────────────${reset}`);
  console.log(`  ${brightCyan}aerorepl projects${reset}                        List project workspaces (matches Web UI)`);
  console.log(`  ${brightCyan}aerorepl traces -p <project>${reset}             List traces in a project workspace`);
  console.log(`  ${brightCyan}aerorepl record -w <cmd>${reset}                 Record interactively (answers input() in CLI)`);
  console.log(`  ${brightCyan}aerorepl replay -w ${latestRunId}${reset}        Replay from cassette at $0.00`);
  console.log(`  ${brightCyan}aerorepl fork ${latestRunId} <spanId> -p "..."${reset} Fork with modified prompt`);
  console.log(`  ${brightCyan}aerorepl diff ${latestTraceId} <childId>${reset}  Compare parent vs forked trace`);
  console.log(`  ${brightCyan}aerorepl session ${latestRunId}${reset}          Interactive REPL (/spans, /step, /fork)`);
  console.log(`  ${brightCyan}aerorepl list${reset}                            List all recorded, replayed, and forked runs`);
  console.log(`  ${brightCyan}aerorepl status ${latestRunId}${reset}           Inspect run status, errors, and trace ID`);
  console.log(`  ${brightCyan}aerorepl config get -p <project>${reset}         View workspace command, venv & policy`);

  console.log(`\n${dim}Web UI:${reset}     ${cyan}http://localhost:5173${reset}`);
  console.log(`${dim}Need help?${reset} Run ${brightCyan}aerorepl --help${reset} for examples and all flags.\n`);
}

export function createProgram(customClient?: AereplClient): Command {
  const config = getProjectConfig();
  const client =
    customClient ||
    new AereplClient(config.orchestratorUrl, config.collectorUrl);

  const program = new Command();
  program
    .name("aerorepl")
    .description("Interactive CLI for AeroGraph deterministic replay, recording, and step inspection.")
    .version("0.4.5")
    .enablePositionalOptions()
    .action(async () => {
      await renderLandingScreen(config, client);
    });

  program.addHelpText(
    "after",
    `
${c.bold}Guided Examples:${c.reset}
  ${c.dim}# 1. Browse workspaces & traces (matches Web UI)${c.reset}
  ${c.brightCyan}$ aerorepl projects${c.reset}
  ${c.brightCyan}$ aerorepl traces -p city-briefing${c.reset}

  ${c.dim}# 2. View or configure a project workspace (auto-detects .venv)${c.reset}
  ${c.brightCyan}$ aerorepl config get -p city-briefing${c.reset}
  ${c.brightCyan}$ aerorepl config set -p travel-planner python travel_agent.py${c.reset}

  ${c.dim}# 3. Record interactively (handles input() prompts right in your terminal)${c.reset}
  ${c.brightCyan}$ aerorepl record -w python examples/city-briefing-agent-py/city_briefing_agent.py${c.reset}

  ${c.dim}# 4. Replay at $0.00, inspect spans, fork with a new prompt, and diff${c.reset}
  ${c.brightCyan}$ aerorepl replay -w <runId>${c.reset}
  ${c.brightCyan}$ aerorepl session <runId>${c.reset}          ${c.dim}(use /spans, /step, /override, /fork, /help)${c.reset}
  ${c.brightCyan}$ aerorepl fork <runId> <spanId> -p "Create a 2 bullet summary" -w${c.reset}
  ${c.brightCyan}$ aerorepl diff <parentTraceId> <childTraceId>${c.reset}
`
  );

  function handleError(err: any) {
    console.error(`Error: ${err.message || String(err)}`);
    process.exit(1);
  }

  async function promptLine(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  async function watchRunUntilDone(runId: string): Promise<void> {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frameIdx = 0;
    let lastHandledTurn: number | null = null;
    while (true) {
      const waitState = await client.getInputWait(runId);
      if (waitState.waiting && waitState.turn !== lastHandledTurn) {
        if (process.stdout.isTTY) {
          process.stdout.write("\r\x1b[K");
        }
        const turnNum: number = waitState.turn ?? 0;
        const promptLabel = waitState.prompt || `Enter input (Turn ${turnNum + 1}): `;
        const answer = await promptLine(`${c.brightCyan}[Agent Input · Turn ${turnNum + 1}]${c.reset} ${promptLabel}`);
        await client.submitInput(runId, turnNum, answer);
        lastHandledTurn = turnNum;
      }

      const run = await client.getRun(runId);
      if (run.status !== "pending" && run.status !== "running") {
        if (process.stdout.isTTY) {
          process.stdout.write("\r\x1b[K");
        }
        console.log(`\n${formatStatusBadge(run.status)}  Run ${c.bold}${run.runId}${c.reset} (Trace: ${c.cyan}${run.traceId}${c.reset})`);
        if (run.errorMessage) {
          console.log(`${c.red}Error:${c.reset} ${run.errorMessage}`);
        }
        console.log(`${c.dim}Next:${c.reset}  aerorepl replay ${run.runId}  |  aerorepl session ${run.runId}  |  http://localhost:5173`);
        return;
      }
      if (process.stdout.isTTY) {
        const spinner = frames[frameIdx++ % frames.length];
        process.stdout.write(`\r${c.cyan}${spinner}${c.reset} Running ${c.bold}${runId}${c.reset} (${run.status})...`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  program
    .command("record [command...]")
    .description("Record an agent execution run (command optional if already configured)")
    .passThroughOptions()
    .option("--json", "Output response in JSON format")
    .option("-w, --watch", "Wait for run completion and print final status")
    .action(async (cmdArray: string[] | undefined, options: { json?: boolean; watch?: boolean }) => {
      try {
        let finalCommand = cmdArray;
        if (!finalCommand || finalCommand.length === 0) {
          const loaded = getProjectConfig();
          if (loaded.command && loaded.command.length > 0) {
            finalCommand = loaded.command;
          }
        }
        if (!finalCommand || finalCommand.length === 0) {
          throw new Error(
            "Missing agent command. Provide a command (e.g. npx aerorepl record -- uv run agent.py) or set default with 'npx aerorepl config set <command...>'."
          );
        }

        // Auto-save command to .aerograph/aerograph.project.yaml if not set
        try {
          saveProjectConfig(finalCommand, config.projectRoot);
        } catch {
          // non-blocking
        }

        const { virtualEnv, executablePath } = detectVirtualEnv(config.projectRoot);

        const res = await client.startRun({
          mode: "record",
          command: finalCommand,
          projectRoot: config.projectRoot,
          virtualEnv: virtualEnv ?? undefined,
          executablePath: executablePath ?? undefined,
          stdinMode: options.watch ? "pipe" : (process.stdin.isTTY ? "inherit" : "pipe")
        });
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            `Started record run ${res.runId} (trace: ${res.traceId}, status: ${res.status})`
          );
          console.log(`  ${c.dim}Command:${c.reset} ${finalCommand.join(" ")}`);
          console.log(`  ${c.dim}Web UI:${c.reset}  http://localhost:5173`);
          if (options.watch) {
            await watchRunUntilDone(res.runId);
          } else {
            console.log(`  ${c.dim}Tip:${c.reset}     Add ${c.brightCyan}-w${c.reset} to watch live & answer input() prompts here`);
            console.log(`  ${c.dim}Next:${c.reset}    aerorepl status ${res.runId}  |  aerorepl replay ${res.runId}`);
          }
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  async function printConfigSummary(projectId?: string): Promise<void> {
    let cfg = getProjectConfig();
    if (projectId) {
      try {
        const remote = await client.getProjectConfig(projectId);
        if (remote?.projectRoot) {
          cfg = {
            version: remote.config?.version || "1.0.0",
            command: remote.config?.command || [],
            collectorUrl: cfg.collectorUrl,
            orchestratorUrl: cfg.orchestratorUrl,
            projectRoot: remote.projectRoot
          };
        }
      } catch {
        // Fallback to local
      }
    }
    const envInfo = detectVirtualEnv(cfg.projectRoot);
    console.log(`${c.bold}Project Root:${c.reset}     ${cfg.projectRoot}`);
    console.log(
      `${c.bold}Virtual Env:${c.reset}      ${
        envInfo.virtualEnv ? `${c.green}${envInfo.virtualEnv}${c.reset}` : `${c.yellow}(none detected)${c.reset}`
      }`
    );
    console.log(
      `${c.bold}Active Command:${c.reset}   ${
        cfg.command && cfg.command.length > 0 ? `${c.cyan}${cfg.command.join(" ")}${c.reset}` : "(none configured)"
      }`
    );
    console.log(`${c.bold}Collector URL:${c.reset}    ${cfg.collectorUrl || "http://127.0.0.1:4317"}`);
    console.log(`${c.bold}Orchestrator URL:${c.reset} ${cfg.orchestratorUrl || "http://127.0.0.1:4318"}`);

    const policyPath = findReplayPolicyPath(cfg.projectRoot);
    if (policyPath) {
      try {
        const raw = fs.readFileSync(policyPath, "utf-8");
        const parsed = yaml.load(raw) as any;
        const count = Array.isArray(parsed?.tools) ? parsed.tools.length : 0;
        const hasNorm = Boolean(parsed?.normalization);
        console.log(
          `${c.bold}Tool Policy:${c.reset}      ${policyPath} (${count} rule${count === 1 ? "" : "s"}${hasNorm ? ", normalization enabled" : ""})`
        );
      } catch {
        console.log(`${c.bold}Tool Policy:${c.reset}      ${policyPath} (present)`);
      }
    } else {
      console.log(`${c.bold}Tool Policy:${c.reset}      (none configured — create aerograph.replay.yaml to declare safety rules)`);
    }
  }

  const configCmd = program
    .command("config")
    .description("View, set, or paste project configuration for AeroGraph replay")
    .option("-p, --project <projectId>", "Target project workspace ID")
    .action(async (options: { project?: string }) => {
      await printConfigSummary(options.project);
    });

  configCmd
    .command("get")
    .description("Display active project and tool safety policy configuration")
    .option("-p, --project <projectId>", "Target project workspace ID")
    .action(async (options: { project?: string }) => {
      await printConfigSummary(options.project);
    });

  configCmd
    .command("set <command...>")
    .description("Set and store the agent command in .aerograph/aerograph.project.yaml")
    .option("-p, --project <projectId>", "Target project workspace ID")
    .action(async (cmdParts: string[], options: { project?: string }) => {
      try {
        if (options.project) {
          const res = await client.saveProjectConfig({ command: cmdParts, projectId: options.project });
          console.log(`${c.green}✓ Configured command for project '${options.project}':${c.reset} ${cmdParts.join(" ")}`);
          console.log(`  Stored in: ${res.path}`);
          return;
        }
        const cfg = getProjectConfig();
        const savedPath = saveProjectConfig(cmdParts, cfg.projectRoot || process.cwd());
        console.log(`${c.green}✓ Configured agent command:${c.reset} ${cmdParts.join(" ")}`);
        console.log(`  Stored in: ${savedPath}`);
      } catch (err: any) {
        handleError(err);
      }
    });

  configCmd
    .command("paste [filePath]")
    .description("Paste or import aerograph.project.yaml or aerograph.replay.yaml")
    .option("-f, --file <filePath>", "Path to YAML file to import")
    .action(async (filePathArg: string | undefined, options: { file?: string }) => {
      const targetFile = filePathArg || options.file;
      let rawYaml = "";

      if (targetFile) {
        try {
          rawYaml = fs.readFileSync(path.resolve(targetFile), "utf-8");
          console.log(`Reading configuration from: ${targetFile}`);
        } catch (fErr: any) {
          console.error(`Error reading file '${targetFile}': ${fErr.message}`);
          return;
        }
      } else {
        console.log("Paste your configuration below (.aerograph/aerograph.project.yaml or aerograph.replay.yaml).");
        console.log("When finished, type 'END' on a new line and press Enter (or press Ctrl+D / Ctrl+Z):\n");

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: false
        });
        const lines: string[] = [];
        let emptyLineCount = 0;

        for await (const line of rl) {
          const trimmedLine = line.trim();
          if (
            trimmedLine.toUpperCase() === "END" ||
            trimmedLine.toUpperCase() === "EOF" ||
            trimmedLine === ":wq"
          ) {
            break;
          }
          if (trimmedLine === "") {
            emptyLineCount++;
            if (emptyLineCount >= 2 && lines.length > 0) {
              break;
            }
          } else {
            emptyLineCount = 0;
          }
          lines.push(line);
        }
        rl.close();
        if (typeof process.stdin.pause === "function") {
          process.stdin.pause();
        }
        rawYaml = lines.join("\n").trim();
      }

      if (!rawYaml) {
        console.error("Error: No YAML content provided.");
        process.exit(1);
      }

      try {
        const res = saveYamlAutoDetect(rawYaml, process.cwd());
        for (let i = 0; i < res.savedFiles.length; i++) {
          const typeLabel =
            res.types[i] === "policy"
              ? "Tool Safety Policy (aerograph.replay.yaml)"
              : "Agent Project Config (.aerograph/aerograph.project.yaml)";
          console.log(`✓ Successfully saved ${typeLabel} to:`);
          console.log(`  ${res.savedFiles[i]}`);
        }
        process.exit(0);
      } catch (err: any) {
        console.error(`Failed to save configuration: ${err.message}`);
        process.exit(1);
      }
    });

  configCmd
    .command("import <filePath>")
    .description("Import configuration directly from a YAML file")
    .action((filePath: string) => {
      try {
        const rawYaml = fs.readFileSync(path.resolve(filePath), "utf-8");
        const res = saveYamlAutoDetect(rawYaml, process.cwd());
        for (let i = 0; i < res.savedFiles.length; i++) {
          const typeLabel =
            res.types[i] === "policy"
              ? "Tool Safety Policy"
              : "Agent Project Config";
          console.log(`✓ Imported ${typeLabel} to: ${res.savedFiles[i]}`);
        }
      } catch (err: any) {
        console.error(`Failed to import configuration: ${err.message}`);
      }
    });

  program
    .command("projects")
    .alias("workspaces")
    .description("List all project workspaces from Collector")
    .option("--json", "Output response in JSON format")
    .action(async (options: { json?: boolean }) => {
      try {
        const { traces } = await client.listTraces();
        const byProject = new Map<string, { count: number; envs: Set<string>; latestTraceId: string; updatedAt: string }>();
        for (const t of traces || []) {
          const pid = t.projectId || "default";
          const entry = byProject.get(pid) || {
            count: 0,
            envs: new Set<string>(),
            latestTraceId: t.traceId,
            updatedAt: t.updatedAt || t.createdAt
          };
          entry.count++;
          if (t.environment) entry.envs.add(t.environment);
          byProject.set(pid, entry);
        }
        const rows = Array.from(byProject.entries()).map(([projectId, info]) => ({
          projectId,
          traces: info.count,
          environments: Array.from(info.envs),
          latestTraceId: info.latestTraceId,
          updatedAt: info.updatedAt
        }));
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(`${c.dim}No project workspaces found yet.${c.reset}`);
          return;
        }
        console.log(`${c.bold}${"PROJECT".padEnd(22)} ${"TRACES".padEnd(9)} ${"ENVS".padEnd(16)} ${"LATEST TRACE"}${c.reset}`);
        console.log(c.dim + "-".repeat(74) + c.reset);
        for (const r of rows) {
          console.log(
            `${c.bold}${r.projectId.padEnd(22)}${c.reset} ${String(r.traces).padEnd(9)} ${(r.environments.join(",") || "default").padEnd(16)} ${c.cyan}${r.latestTraceId}${c.reset}`
          );
        }
        console.log(`\n${c.dim}Tip:${c.reset} View traces in a workspace with ${c.brightCyan}aerorepl traces -p <project>${c.reset}`);
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("traces")
    .description("List recorded traces (optionally filtered by project workspace)")
    .option("-p, --project <projectId>", "Filter by project workspace ID")
    .option("--json", "Output response in JSON format")
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const { traces } = await client.listTraces(options.project);
        if (options.json) {
          console.log(JSON.stringify(traces, null, 2));
          return;
        }
        if (!traces || traces.length === 0) {
          console.log(`${c.dim}No traces found.${c.reset}`);
          return;
        }
        console.log(`${c.bold}${"TRACE ID".padEnd(20)} ${"PROJECT".padEnd(18)} ${"EVENTS".padEnd(8)} ${"MODE".padEnd(18)} ${"RUN ID"}${c.reset}`);
        console.log(c.dim + "-".repeat(86) + c.reset);
        for (const t of traces.slice(0, 25)) {
          const modeStr = t.replayRun?.mode ? formatModeBadge(t.replayRun.mode).padEnd(27) : `${c.dim}sdk${c.reset}`.padEnd(18);
          console.log(
            `${c.cyan}${String(t.traceId).padEnd(20)}${c.reset} ${String(t.projectId || "default").padEnd(18)} ${String(t.eventCount ?? 0).padEnd(8)} ${modeStr} ${c.dim}${t.replayRun?.runId || "-"}${c.reset}`
          );
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("fork <runId> <spanId>")
    .description("Fork and resume from a span with a modified prompt")
    .option("-p, --prompt <text>", "New prompt text to trigger a diverged fork")
    .option("-w, --watch", "Wait for fork completion and print final status")
    .option("--json", "Output response in JSON format")
    .action(async (runId: string, spanId: string, options: { prompt?: string; watch?: boolean; json?: boolean }) => {
      try {
        const run = await client.getRun(runId);
        if (!options.prompt && !options.json) {
          console.log(`${c.yellow}Tip:${c.reset} No --prompt (-p) provided; fork will use the original prompt.`);
        }
        const res = await client.forkFromSpan(
          run.traceId,
          spanId,
          options.prompt,
          run.projectRoot || config.projectRoot,
          run.command && run.command.length > 0 ? run.command : undefined
        );
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`${c.green}✓ Forked trace${c.reset} ${c.cyan}${run.traceId}${c.reset} at ${c.bold}${spanId}${c.reset}`);
          console.log(`  Child Trace: ${c.cyan}${res.childTraceId}${c.reset}`);
          console.log(`  Run ID:      ${c.bold}${res.runId}${c.reset} (${res.status})`);
          if (options.watch) {
            await watchRunUntilDone(res.runId);
          } else {
            console.log(`  ${c.dim}Next:${c.reset}        aerorepl status ${res.runId}  |  http://localhost:5173`);
          }
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("diff <traceA> <traceB>")
    .description("Compare two traces (e.g. parent vs forked trace)")
    .option("--json", "Output response in JSON format")
    .action(async (traceA: string, traceB: string, options: { json?: boolean }) => {
      try {
        const diff = await client.getDiff(traceA, traceB);
        if (options.json) {
          console.log(JSON.stringify(diff, null, 2));
          return;
        }
        console.log(`${c.bold}Trace Diff:${c.reset} ${c.cyan}${traceA}${c.reset} ↔ ${c.cyan}${traceB}${c.reset}`);
        console.log(c.dim + "─".repeat(64) + c.reset);
        const summary = diff?.summary;
        if (summary) {
          console.log(
            `  ${c.dim}Matched:${c.reset} ${summary.matched ?? 0}   ` +
            `${c.green}+ Added:${c.reset} ${summary.added ?? 0}   ` +
            `${c.red}- Removed:${c.reset} ${summary.removed ?? 0}`
          );
        }
        if (diff?.tokenDelta) {
          const delta = diff.tokenDelta.deltaTokens ?? 0;
          const deltaColor = delta <= 0 ? c.green : c.yellow;
          console.log(`  ${c.bold}Token Delta:${c.reset} ${deltaColor}${delta > 0 ? `+${delta}` : delta} tokens${c.reset}`);
        }
        console.log(`${c.dim}Web UI (Myers Diff):${c.reset} ${c.cyan}http://localhost:5173${c.reset}`);
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("replay <runId>")
    .description("Replay an existing run from cassette cache")
    .option("--json", "Output response in JSON format")
    .option("-w, --watch", "Wait for replay completion and print final status")
    .action(async (runId: string, options: { json?: boolean; watch?: boolean }) => {
      try {
        const res = await client.startRun({
          mode: "replay",
          cassetteRunId: runId,
          projectRoot: config.projectRoot
        });
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            `Started replay run ${res.runId} (trace: ${res.traceId}, status: ${res.status})`
          );
          console.log(`  ${c.dim}Web UI:${c.reset} http://localhost:5173`);
          if (options.watch) {
            await watchRunUntilDone(res.runId);
          } else {
            console.log(`  ${c.dim}Next:${c.reset}   aerorepl status ${res.runId}  |  aerorepl session ${res.runId}`);
          }
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("list")
    .description("List all runs")
    .option("--json", "Output response in JSON format")
    .action(async (options: { json?: boolean }) => {
      try {
        const runs = await client.listRuns();
        if (options.json) {
          console.log(JSON.stringify(runs, null, 2));
        } else {
          if (!runs || runs.length === 0) {
            console.log(`${c.dim}No runs found. Start one with:${c.reset} aerorepl record`);
            return;
          }
          console.log(
            `${c.bold}${"RUN ID".padEnd(20)} ${"TRACE ID".padEnd(20)} ${"MODE".padEnd(18)} ${"STATUS".padEnd(14)} ${"STARTED"}${c.reset}`
          );
          console.log(c.dim + "-".repeat(92) + c.reset);
          for (const run of runs) {
            const started = run.startedAt ? new Date(run.startedAt).toLocaleString() : "N/A";
            console.log(
              `${c.bold}${run.runId.padEnd(20)}${c.reset} ${c.cyan}${run.traceId.padEnd(20)}${c.reset} ${formatModeBadge(run.mode).padEnd(27)} ${formatStatusBadge(run.status).padEnd(23)} ${c.dim}${started}${c.reset}`
            );
          }
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("status <runId>")
    .description("Show status and details of a run")
    .option("--json", "Output response in JSON format")
    .action(async (runId: string, options: { json?: boolean }) => {
      try {
        const run = await client.getRun(runId);
        if (options.json) {
          console.log(JSON.stringify(run, null, 2));
        } else {
          console.log(`${c.bold}Run ID:${c.reset}        ${run.runId}`);
          console.log(`${c.bold}Trace ID:${c.reset}      ${c.cyan}${run.traceId}${c.reset}`);
          console.log(`${c.bold}Mode:${c.reset}          ${formatModeBadge(run.mode)}`);
          console.log(`${c.bold}Status:${c.reset}        ${formatStatusBadge(run.status)}`);
          console.log(`${c.bold}Started:${c.reset}       ${run.startedAt ? new Date(run.startedAt).toLocaleString() : "N/A"}`);
          console.log(`${c.bold}Completed:${c.reset}     ${run.completedAt ? new Date(run.completedAt).toLocaleString() : "N/A"}`);
          if (run.errorMessage) {
            console.log(`${c.red}Error:${c.reset}         ${run.errorMessage}`);
          }
          console.log(`${c.dim}Next:${c.reset}          aerorepl replay ${run.runId}  |  aerorepl session ${run.runId}`);
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("cancel <runId>")
    .description("Cancel an active run")
    .option("--json", "Output response in JSON format")
    .action(async (runId: string, options: { json?: boolean }) => {
      try {
        const res = await client.cancelRun(runId);
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Cancelled run ${runId}: ${res.message}`);
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  program
    .command("session <runId>")
    .description("Start an interactive step inspection session for a run")
    .action(async (runId: string) => {
      try {
        const init = await client.createSession(runId);
        const session = await client.getSession(init.sessionId);
        let runStatus: string | undefined;
        let runErrorMessage: string | null | undefined;
        try {
          const run = await client.getRun(runId);
          runStatus = run.status;
          runErrorMessage = run.errorMessage;
          (session as any).runStatus = run.status;
        } catch {
          // Non-blocking
        }

        console.log(`${c.green}✓ Interactive REPL session started:${c.reset} ${c.bold}${session.sessionId}${c.reset} (Run: ${c.cyan}${runId}${c.reset})`);
        if (runStatus === "failed" || runStatus === "crashed") {
          console.log(`${c.yellow}⚠️  Warning: Run ${runId} has status '${runStatus}'.${c.reset}`);
          if (runErrorMessage) {
            const firstLine = runErrorMessage.trim().split("\n")[0];
            console.log(`   Error: ${firstLine}`);
          }
          console.log("   Cassette steps can be replayed and inspected, but live agent spans are not available.\n");
        }
        console.log(`${c.dim}Commands: /step, /inspect <spanId>, /override <spanId> [text|json|@file], /rewind <N>, /fork <spanId>, /help, /quit${c.reset}\n`);

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: "aerorepl> "
        });

        let isAccumulating = false;
        let accumulatedLines: string[] = [];
        let pendingSpanId = "";

        rl.prompt();

        rl.on("line", async (line) => {
          const trimmed = line.trim();

          if (!isAccumulating) {
            if (trimmed === "/quit" || trimmed === "/exit") {
              rl.close();
              return;
            }

            if (trimmed.startsWith("/override")) {
              const match = trimmed.match(/^\/override\s+(\S+)(?:\s+([\s\S]+))?$/);
              if (match) {
                const [, spanId, rest] = match;
                const restTrimmed = (rest || "").trim();
                const isMultiLineStart =
                  !restTrimmed ||
                  (restTrimmed.startsWith("{") && !restTrimmed.endsWith("}"));

                if (isMultiLineStart) {
                  isAccumulating = true;
                  pendingSpanId = spanId;
                  accumulatedLines = restTrimmed ? [restTrimmed] : [];
                  console.log(
                    `Entering multi-line override for ${spanId}. Paste/enter JSON or prompt text, then type 'END' on a new line when done:`
                  );
                  rl.setPrompt("override> ");
                  rl.prompt();
                  return;
                }
              }
            }

            if (trimmed) {
              try {
                const output = await handleSessionCommand(trimmed, session, client);
                console.log(output);
              } catch (cmdErr: any) {
                console.error(`Session error: ${cmdErr.message || cmdErr}`);
              }
            }
          } else {
            // Multi-line accumulation mode
            const isEndMarker =
              trimmed.toUpperCase() === "END" ||
              trimmed.toUpperCase() === "EOF" ||
              trimmed === ":wq";

            if (!isEndMarker) {
              accumulatedLines.push(line);
            }

            const combined = accumulatedLines.join("\n").trim();
            let isComplete = false;

            if (isEndMarker) {
              isComplete = true;
            } else if (combined.startsWith("{")) {
              // Only mark complete if the accumulated string forms a valid, closed JSON object
              try {
                JSON.parse(combined);
                isComplete = true;
              } catch {
                // Incomplete JSON (inner braces closed but outer still open)
                isComplete = false;
              }
            }

            if (isComplete) {
              isAccumulating = false;
              rl.setPrompt("aerorepl> ");
              const fullCommand = `/override ${pendingSpanId} ${combined}`;
              accumulatedLines = [];
              try {
                const output = await handleSessionCommand(fullCommand, session, client);
                console.log(output);
              } catch (cmdErr: any) {
                console.error(`Session error: ${cmdErr.message || cmdErr}`);
              }
              rl.prompt();
              return;
            } else {
              rl.prompt();
              return;
            }
          }

          rl.prompt();
        });

        rl.on("close", () => {
          console.log("Session terminated.");
          process.exit(0);
        });
      } catch (err: any) {
        handleError(err);
      }
    });

  return program;
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((err) => {
    console.error(`Fatal: ${err.message || String(err)}`);
    process.exit(1);
  });
}
