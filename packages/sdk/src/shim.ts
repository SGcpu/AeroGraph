import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getCurrentBranchId, getCurrentSpanId, nextLocalSeq } from "./context.js";

const PROTECTED_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "AEROREPL_MODE",
  "AEROREPL_RUN_ID",
  "AFR_RUN_ID",
  "AFR_TRACE_ID",
  "AEROGRAPH_MODE",
  "AEROGRAPH_ORCHESTRATOR_URL",
  "AEROGRAPH_ENDPOINT",
  "AEROGRAPH_CASSETTE_RUN_ID",
  "AEROGRAPH_THREAD_ID"
]);

function loadDotenvWithProxyPrecedence(): void {
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const clean = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eqIdx = clean.indexOf("=");
      const key = clean.slice(0, eqIdx).trim();
      let val = clean.slice(eqIdx + 1).trim();
      if (
        val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      ) {
        val = val.slice(1, -1);
      }
      if (!key || PROTECTED_ENV_KEYS.has(key) || key in process.env) continue;
      if (key.startsWith("AEROGRAPH_") || key.startsWith("AFR_") || key.startsWith("AEROREPL_")) continue;
      process.env[key] = val;
    }
  } catch {
    // Never crash user code
  }
}

function orchUrl(): string {
  return (process.env.AEROGRAPH_ORCHESTRATOR_URL || "http://127.0.0.1:4318").replace(/\/$/, "");
}

function collectorUrl(): string {
  return (process.env.AEROGRAPH_ENDPOINT || "http://127.0.0.1:4317").replace(/\/$/, "");
}

function runId(): string {
  return process.env.AFR_RUN_ID || process.env.AEROREPL_RUN_ID || "";
}

function cassetteRunId(): string {
  return process.env.AEROGRAPH_CASSETTE_RUN_ID || runId();
}

function mode(): string {
  return (process.env.AEROGRAPH_MODE || process.env.AEROREPL_MODE || "").toLowerCase();
}

function isInternalUrl(urlStr: string): boolean {
  return (
    urlStr.startsWith(orchUrl()) ||
    urlStr.startsWith(collectorUrl()) ||
    urlStr.includes("127.0.0.1:4317") ||
    urlStr.includes("127.0.0.1:4318") ||
    urlStr.includes("localhost:4317") ||
    urlStr.includes("localhost:4318")
  );
}

function getContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const spanId = getCurrentSpanId();
  const branchId = getCurrentBranchId();
  const seq = nextLocalSeq(branchId);
  if (spanId) headers["X-AeroGraph-Span-Id"] = spanId;
  if (branchId) headers["X-AeroGraph-Branch-Id"] = branchId;
  headers["X-AeroGraph-Local-Seq"] = String(seq);
  return headers;
}

const origFetch = globalThis.fetch;

async function internalJson(method: string, urlStr: string, payload?: unknown): Promise<any> {
  try {
    const res = await origFetch(urlStr, {
      method,
      headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
      body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function patchFetch(): void {
  if (typeof globalThis.fetch !== "function" || (globalThis.fetch as any).__aerographPatched) {
    return;
  }
  const wrappedFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (isInternalUrl(urlStr)) {
      return origFetch(input, init);
    }
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(getContextHeaders())) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return origFetch(input, { ...init, headers });
  };
  (wrappedFetch as any).__aerographPatched = true;
  globalThis.fetch = wrappedFetch;
}

function patchHttpModule(mod: typeof http | typeof https): void {
  const origReq = mod.request;
  if ((origReq as any).__aerographPatched) return;
  const wrappedReq: any = function (this: any, ...args: any[]) {
    const first = args[0];
    let urlStr = "";
    if (typeof first === "string") urlStr = first;
    else if (first instanceof URL) urlStr = first.toString();
    else if (first && typeof first === "object") {
      urlStr = `${first.protocol || "http:"}//${first.hostname || first.host || "localhost"}:${first.port || ""}${first.path || ""}`;
    }
    if (!isInternalUrl(urlStr)) {
      const ctxHeaders = getContextHeaders();
      if (first && typeof first === "object" && !(first instanceof URL)) {
        first.headers = { ...ctxHeaders, ...(first.headers || {}) };
      } else if (args[1] && typeof args[1] === "object" && typeof args[1] !== "function") {
        args[1].headers = { ...ctxHeaders, ...(args[1].headers || {}) };
      }
    }
    return (origReq as any).apply(this, args);
  };
  wrappedReq.__aerographPatched = true;
  (mod as any).request = wrappedReq;
}

let turnCounter = 0;
let cachedInbound: Array<{ turn: number; payload: string }> | null = null;

async function getRecordedInbound(): Promise<Array<{ turn: number; payload: string }>> {
  if (cachedInbound !== null) return cachedInbound;
  const cid = cassetteRunId();
  if (cid) {
    const res = await internalJson("GET", `${orchUrl()}/v1/runs/${cid}/inbound`);
    if (res && Array.isArray(res.inbound)) {
      cachedInbound = res.inbound;
      return cachedInbound!;
    }
  }
  cachedInbound = [];
  return cachedInbound;
}

function patchReadline(): void {
  const proto = readline.Interface.prototype as any;
  if (proto.__aerographPatched) return;
  const origQuestion = proto.question;
  proto.__aerographPatched = true;

  proto.question = function (query: string, ...rest: any[]) {
    const m = mode();
    if (m !== "record" && m !== "replay" && m !== "fork") {
      return origQuestion.call(this, query, ...rest);
    }

    const cb = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : null;
    const turn = turnCounter++;
    const rid = runId();
    const spanId = getCurrentSpanId();

    const finish = (answer: string) => {
      if (cb) cb(answer);
    };

    (async () => {
      if (m === "replay" || m === "fork") {
        try {
          const rawOvr = process.env.AEROGRAPH_INBOUND_OVERRIDES;
          if (rawOvr) {
            const ovr = JSON.parse(rawOvr);
            if (String(turn) in ovr) {
              finish(String(ovr[String(turn)]));
              return;
            }
          }
        } catch {
          // ignore
        }
        const inbound = await getRecordedInbound();
        const found = inbound.find((e) => e.turn === turn) ?? inbound[turn];
        if (found) {
          finish(String(found.payload ?? ""));
          return;
        }
      }

      if (process.stdin.isTTY) {
        origQuestion.call(this, query, (ans: string) => {
          if (rid) {
            void internalJson("POST", `${orchUrl()}/v1/runs/${rid}/inbound`, {
              channel: "stdin",
              turn,
              prompt: query,
              payload: ans,
              spanId
            });
          }
          finish(ans);
        });
        return;
      }

      if (rid) {
        await internalJson("POST", `${orchUrl()}/v1/runs/${rid}/input-wait`, {
          turn,
          prompt: query,
          spanId
        });
        while (true) {
          const state = await internalJson("GET", `${orchUrl()}/v1/runs/${rid}/input-wait`);
          if (state && state.waiting === false) {
            const ans = String(state.payload ?? "");
            await internalJson("POST", `${orchUrl()}/v1/runs/${rid}/inbound`, {
              channel: "stdin",
              turn,
              prompt: query,
              payload: ans,
              spanId
            });
            finish(ans);
            return;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    })().catch(() => {
      origQuestion.call(this, query, ...rest);
    });
  };
}

try {
  loadDotenvWithProxyPrecedence();
  patchFetch();
  patchHttpModule(http);
  patchHttpModule(https);
  patchReadline();
} catch {
  // Never crash user code
}
