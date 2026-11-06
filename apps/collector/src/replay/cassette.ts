import fs from "fs";
import path from "path";
import {
  validateCassette,
  type Cassette,
  type CassetteEntry
} from "@aerograph/contracts";

/**
 * Validates that the requested cassette path does not escape the project's
 * .aerograph/cassettes directory (Path Traversal Protection).
 */
export function validateCassettePath(runId: string, projectRoot: string): string {
  // Reject obvious traversal characters in runId
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`Invalid runId: path traversal characters detected: "${runId}"`);
  }

  const cassettesDir = path.resolve(projectRoot, ".aerograph", "cassettes");
  const targetFile = path.resolve(cassettesDir, `${runId}.json`);

  if (!targetFile.startsWith(cassettesDir)) {
    throw new Error(`Path traversal attempt detected for runId: ${runId}`);
  }

  return targetFile;
}

/**
 * Checks if a cassette file exists.
 */
export function cassetteExists(runId: string, projectRoot: string): boolean {
  try {
    const aeroFile = path.resolve(projectRoot, ".aerograph", "cassettes", `${runId}.json`);
    const agentFile = path.resolve(projectRoot, ".agent-replay", "runs", `${runId}.json`);
    const target = fs.existsSync(aeroFile) ? aeroFile : fs.existsSync(agentFile) ? agentFile : null;
    if (!target) return false;
    const content = fs.readFileSync(target, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed?.steps) && parsed.steps.length > 0) return true;
    if (Array.isArray(parsed?.entries) && parsed.entries.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Reads and validates a cassette from .aerograph/cassettes/<runId>.json.
 * Throws an actionable error if the cassette is missing or unreadable.
 */
export function readCassette(runId: string, projectRoot: string): Cassette {
  const filePath = validateCassettePath(runId, projectRoot);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Cassette for run ${runId} is missing or unreadable at ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Cassette for run ${runId} is missing or unreadable at ${filePath}: ${err}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Cassette for run ${runId} is corrupted or invalid JSON: ${err}`);
  }

  // Handle native Go storage format { run_id, original_command, steps: [...] }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.steps)) {
    const rawSteps = parsed.steps;
    return {
      cassetteVersion: "1.0.0",
      runId: parsed.run_id || runId,
      traceId: parsed.trace_id || "",
      command: [(parsed.original_command || "")],
      recordedAt: new Date().toISOString(),
      entries: rawSteps.map((s: any, idx: number) => ({
        index: idx,
        correlatedSpanId: s.correlated_span_id || s.correlatedSpanId || "",
        request: {
          method: s.request?.method || "GET",
          url: s.request?.url || "",
          headers: s.request?.headers || {},
          body: s.request?.body || ""
        },
        response: {
          status: s.response?.status || "200 OK",
          statusCode: s.response?.statusCode || 200,
          headers: s.response?.headers || {},
          body: s.response?.body || "",
          chunks: s.response?.chunks,
          streamingPreserved: s.response?.streamingPreserved
        }
      }))
    };
  }

  try {
    return validateCassette(parsed);
  } catch (err) {
    throw new Error(`Cassette for run ${runId} does not match canonical Cassette schema: ${err}`);
  }
}

/**
 * Atomically writes a cassette file using a temp file rename.
 */
export function writeCassette(runId: string, projectRoot: string, data: Cassette): void {
  const filePath = validateCassettePath(runId, projectRoot);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = path.join(dir, `.${runId}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
}

function getRequestBodyString(body: any): string {
  if (!body) return "";
  if (typeof body === "string") {
    try {
      const decoded = Buffer.from(body, "base64").toString("utf-8");
      if (decoded.includes("{") || decoded.includes("[")) return decoded;
    } catch {}
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString("utf-8");
  }
  return JSON.stringify(body);
}

/**
 * Creates a partial fork cassette containing only entries strictly before forkFromSpanId.
 * Synchronizes to both .aerograph/cassettes/ and .agent-replay/runs/ so replay-core uses it.
 */
export function writeForkCassette(
  childRunId: string,
  baseCassetteRunId: string,
  forkFromSpanId: string,
  projectRoot: string,
  targetPromptText?: string
): Cassette {
  const baseCassette = readCassette(baseCassetteRunId, projectRoot);

  const cleanTarget = targetPromptText
    ? targetPromptText.replace(/^(human|user|system|assistant):\s*/i, "").trim()
    : "";

  // Filter entries strictly prior to the fork span so the fork point executes live
  const preForkEntries: CassetteEntry[] = [];
  let foundForkSpan = false;

  for (const entry of baseCassette.entries) {
    const rawEntry = entry as any;
    if (rawEntry.correlatedSpanId && rawEntry.correlatedSpanId === forkFromSpanId) {
      foundForkSpan = true;
      break;
    }
    if (cleanTarget && rawEntry.request?.body) {
      const bodyStr = getRequestBodyString(rawEntry.request.body);
      if (bodyStr.includes(cleanTarget.slice(0, 50))) {
        foundForkSpan = true;
        break;
      }
    }
    preForkEntries.push(entry);
  }

  const forkCassette: Cassette = {
    cassetteVersion: "1.0.0",
    runId: childRunId,
    traceId: baseCassette.traceId,
    command: baseCassette.command,
    recordedAt: new Date().toISOString(),
    entries: foundForkSpan ? preForkEntries : baseCassette.entries
  };

  writeCassette(childRunId, projectRoot, forkCassette);

  // Also write native Go replay-core format to .agent-replay/runs/<childRunId>.json
  try {
    const runsDir = path.join(projectRoot, ".agent-replay", "runs");
    if (!fs.existsSync(runsDir)) {
      fs.mkdirSync(runsDir, { recursive: true });
    }
    const runFilePath = path.join(runsDir, `${childRunId}.json`);
    const nativeSteps = forkCassette.entries.map((entry) => {
      const raw = entry as any;
      return {
        type: "http",
        correlated_span_id: raw.correlatedSpanId,
        request: raw.request,
        response: raw.response
      };
    });
    fs.writeFileSync(
      runFilePath,
      JSON.stringify(
        {
          run_id: childRunId,
          original_command: forkCassette.command.join(" "),
          steps: nativeSteps
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch (err) {
    console.warn(`[Cassette] Could not sync partial run file to .agent-replay/runs:`, err);
  }

  return forkCassette;
}
