#!/usr/bin/env node

import { Command } from "commander";
import readline from "readline";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { AereplClient, SessionInfo } from "./client.js";
import {
  loadProjectConfig,
  saveProjectConfig,
  saveYamlAutoDetect,
  findReplayPolicyPath,
  AerographProjectConfig
} from "./config.js";

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
    if (!result.spanSummary) {
      const runStatus = (session as any).runStatus;
      if (runStatus === "failed" || runStatus === "crashed") {
        return `Step ${result.step}: No further spans (Run ${session.runId} ended with status '${runStatus}')`;
      }
      return `Step ${result.step}: No further spans`;
    }
    return `Step ${result.step}: ${result.spanSummary.kind} [${result.spanSummary.spanId}] (${
      result.spanSummary.status || "ok"
    })`;
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
    const parts = trimmed.split(/\s+/);
    const spanId = parts[1];
    if (!spanId) return "Error: /fork requires <spanId>";
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
    .description("Display active project and tool safety policy configuration")
    .action(() => {
      const cfg = getProjectConfig();
      console.log(`Project Root:     ${cfg.projectRoot}`);
      console.log(`Active Command:   ${cfg.command && cfg.command.length > 0 ? cfg.command.join(" ") : "(none configured)"}`);
      console.log(`Collector URL:    ${cfg.collectorUrl || "http://127.0.0.1:4317"}`);
      console.log(`Orchestrator URL: ${cfg.orchestratorUrl || "http://127.0.0.1:4318"}`);

      const policyPath = findReplayPolicyPath(cfg.projectRoot);
      if (policyPath) {
        try {
          const raw = fs.readFileSync(policyPath, "utf-8");
          const parsed = yaml.load(raw) as any;
          const count = Array.isArray(parsed?.tools) ? parsed.tools.length : 0;
          console.log(`Tool Policy:      ${policyPath} (${count} rule${count === 1 ? '' : 's'})`);
        } catch {
          console.log(`Tool Policy:      ${policyPath} (present)`);
        }
      } else {
        console.log(`Tool Policy:      (none configured — create aerograph.replay.yaml to declare safety rules)`);
      }
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

        console.log(`Interactive REPL session started: ${session.sessionId} (Run: ${runId})`);
        if (runStatus === "failed" || runStatus === "crashed") {
          console.log(`⚠️  Warning: Run ${runId} has status '${runStatus}'.`);
          if (runErrorMessage) {
            const firstLine = runErrorMessage.trim().split("\n")[0];
            console.log(`   Error: ${firstLine}`);
          }
          console.log("   Cassette steps can be replayed and inspected, but live agent spans are not available.\n");
        }
        console.log("Commands: /step, /inspect <spanId>, /override <spanId> [text|json|@file], /rewind <N>, /fork <spanId>, /quit\n");

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
