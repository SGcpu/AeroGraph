#!/usr/bin/env node

import { Command } from "commander";
import readline from "readline";
import yaml from "js-yaml";
import { AereplClient, SessionInfo } from "./client.js";
import { loadProjectConfig, saveProjectConfig, AerographProjectConfig } from "./config.js";

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

  if (trimmed === "/step") {
    const result = await client.stepSession(session.sessionId);
    session.currentStep = result.step;
    return `Step ${result.step}: ${
      result.spanSummary
        ? `${result.spanSummary.kind} [${result.spanSummary.spanId}] (${
            result.spanSummary.status || "ok"
          })`
        : "No further spans"
    }`;
  }

  if (trimmed.startsWith("/inspect")) {
    const parts = trimmed.split(/\s+/);
    const spanId = parts[1];
    if (!spanId) return "Error: /inspect requires <spanId>";
    const event = await client.inspectSpan(session.traceId, spanId);
    return JSON.stringify(event, null, 2);
  }

  if (trimmed.startsWith("/override")) {
    const match = trimmed.match(/^\/override\s+(\S+)\s+(.+)$/);
    if (!match) return "Error: /override requires <spanId> <json>";
    const [, spanId, jsonStr] = match;
    let value: any;
    try {
      value = JSON.parse(jsonStr);
    } catch {
      value = jsonStr;
    }
    const result = await client.overrideSpan(session.sessionId, spanId, value);
    return `Overridden span ${result.spanId}`;
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
    const parts = trimmed.split(/\s+/);
    const spanId = parts[1];
    if (!spanId) return "Error: /fork requires <spanId>";
    const result = await client.forkFromSpan(session.traceId, spanId);
    return `Forked trace ${session.traceId} at ${spanId} -> child trace: ${result.childTraceId} (run: ${result.runId}, status: ${result.status})`;
  }

  return `Unknown session command: ${trimmed}. Type /step, /inspect <spanId>, /override <spanId> <json>, /rewind <N>, /fork <spanId>, or /quit.`;
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
    .version("0.3.0")
    .enablePositionalOptions();

  function handleError(err: any) {
    console.error(`Error: ${err.message || String(err)}`);
    process.exit(1);
  }

  program
    .command("record [command...]")
    .description("Record an agent execution run (command optional if already configured)")
    .passThroughOptions()
    .option("--json", "Output response in JSON format")
    .action(async (cmdArray: string[] | undefined, options: { json?: boolean }) => {
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

        const res = await client.startRun({
          mode: "record",
          command: finalCommand,
          projectRoot: config.projectRoot
        });
        if (options.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            `Started record run ${res.runId} (trace: ${res.traceId}, status: ${res.status})`
          );
        }
      } catch (err: any) {
        handleError(err);
      }
    });

  const configCmd = program
    .command("config")
    .description("View, set, or paste project configuration for AeroGraph replay");

  configCmd
    .command("get")
    .description("Display active project configuration")
    .action(() => {
      const cfg = getProjectConfig();
      console.log(`Project Root:     ${cfg.projectRoot}`);
      console.log(`Active Command:   ${cfg.command && cfg.command.length > 0 ? cfg.command.join(" ") : "(none configured)"}`);
      console.log(`Collector URL:    ${cfg.collectorUrl || "http://127.0.0.1:4317"}`);
      console.log(`Orchestrator URL: ${cfg.orchestratorUrl || "http://127.0.0.1:4318"}`);
    });

  configCmd
    .command("set <command...>")
    .description("Set and store the agent command in .aerograph/aerograph.project.yaml")
    .action((cmdParts: string[]) => {
      try {
        const savedPath = saveProjectConfig(cmdParts, process.cwd());
        console.log(`✓ Configured agent command: ${cmdParts.join(" ")}`);
        console.log(`  Stored in: ${savedPath}`);
      } catch (err: any) {
        handleError(err);
      }
    });

  configCmd
    .command("paste")
    .description("Interactively paste aerograph.project.yaml content directly into terminal")
    .action(async () => {
      console.log("Paste your aerograph.project.yaml content below. Press Enter then Ctrl+D (or Ctrl+Z on Windows + Enter) when done:\n");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
      const lines: string[] = [];
      for await (const line of rl) {
        lines.push(line);
      }
      const rawYaml = lines.join("\n").trim();
      if (!rawYaml) {
        console.error("Error: No YAML content provided.");
        return;
      }
      try {
        const parsed = yaml.load(rawYaml) as any;
        if (!parsed || typeof parsed !== "object" || !parsed.command) {
          throw new Error("YAML must contain a 'command' field (e.g. command: [uv, run, agent.py])");
        }
        const cmd = Array.isArray(parsed.command) ? parsed.command : String(parsed.command).trim().split(/\s+/);
        const savedPath = saveProjectConfig(cmd, process.cwd(), parsed);
        console.log(`✓ Successfully saved configuration to: ${savedPath}`);
      } catch (err: any) {
        console.error(`Failed to save YAML config: ${err.message}`);
      }
    });

  program
    .command("replay <runId>")
    .description("Replay an existing run from cassette cache")
    .option("--json", "Output response in JSON format")
    .action(async (runId: string, options: { json?: boolean }) => {
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
            console.log("No runs found.");
            return;
          }
          console.log(
            `${"RUN ID".padEnd(20)} ${"TRACE ID".padEnd(20)} ${"MODE".padEnd(10)} ${"STATUS".padEnd(12)} ${"STARTED"}`
          );
          console.log("-".repeat(80));
          for (const run of runs) {
            console.log(
              `${run.runId.padEnd(20)} ${run.traceId.padEnd(20)} ${run.mode.padEnd(10)} ${run.status.padEnd(12)} ${run.startedAt || "N/A"}`
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
          console.log(`Run ID:        ${run.runId}`);
          console.log(`Trace ID:      ${run.traceId}`);
          console.log(`Mode:          ${run.mode}`);
          console.log(`Status:        ${run.status}`);
          console.log(`Started:       ${run.startedAt || "N/A"}`);
          console.log(`Completed:     ${run.completedAt || "N/A"}`);
          if (run.errorMessage) {
            console.log(`Error:         ${run.errorMessage}`);
          }
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
        console.log(`Interactive REPL session started: ${session.sessionId} (Run: ${runId})`);
        console.log("Commands: /step, /inspect <spanId>, /override <spanId> <json>, /rewind <N>, /fork <spanId>, /quit\n");

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: "aerorepl> "
        });

        rl.prompt();

        rl.on("line", async (line) => {
          const input = line.trim();
          if (input === "/quit" || input === "/exit") {
            rl.close();
            return;
          }
          if (input) {
            try {
              const output = await handleSessionCommand(input, session, client);
              console.log(output);
            } catch (cmdErr: any) {
              console.error(`Session error: ${cmdErr.message || cmdErr}`);
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
