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
    const filePath = validateCassettePath(runId, projectRoot);
    return fs.existsSync(filePath);
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Cassette for run ${runId} is corrupted or invalid JSON: ${err}`);
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

/**
 * Creates a partial fork cassette containing only entries up to forkFromSpanId.
 */
export function writeForkCassette(
  childRunId: string,
  baseCassetteRunId: string,
  forkFromSpanId: string,
  projectRoot: string
): Cassette {
  const baseCassette = readCassette(baseCassetteRunId, projectRoot);

  // Filter entries up to the fork span
  const preForkEntries: CassetteEntry[] = [];
  let foundForkSpan = false;

  for (const entry of baseCassette.entries) {
    preForkEntries.push(entry);
    if (entry.correlatedSpanId === forkFromSpanId) {
      foundForkSpan = true;
      break;
    }
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
  return forkCassette;
}
