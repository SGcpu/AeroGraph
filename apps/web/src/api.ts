import {
  traceForkRequestSchema,
  traceForkResponseSchema,
  traceListResponseSchema,
  traceLineageGraphSchema,
  traceWithMetaSchema,
  traceDiffResultSchema,
  traceAnalysisSchema,
  traceStatsSchema,
  getRunResponseSchema,
  forkAndResumeResponseSchema,
  type TraceForkRequest,
  type TraceForkResponse,
  type TraceListResponse,
  type TraceLineageGraph,
  type TraceWithMeta,
  type TraceDiffResult,
  type TraceAnalysis,
  type TraceStats,
  type GetRunResponse,
  type ForkAndResumeResponse
} from "@aerograph/contracts";

const DEFAULT_COLLECTOR = "http://localhost:4317";
const DEFAULT_ORCHESTRATOR = "http://localhost:4318";

export type ReplayRunResponse = {
  runId: string;
  traceId: string;
  status: string;
};

export type Api = {
  listTraces(filters?: { projectId?: string; environment?: string }): Promise<TraceListResponse>;
  getTrace(traceId: string): Promise<TraceWithMeta>;
  forkTrace(traceId: string, body: TraceForkRequest): Promise<TraceForkResponse>;
  getLineage(traceId: string): Promise<TraceLineageGraph>;
  getDiff(aId: string, bId: string): Promise<TraceDiffResult>;
  getAnalysis(traceId: string): Promise<TraceAnalysis>;
  getStats(traceId: string): Promise<TraceStats>;
  deleteTrace(traceId: string): Promise<void>;
  replayTrace(traceId: string, cassetteRunId?: string): Promise<ReplayRunResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  cancelRun(runId: string): Promise<{ success: boolean; message: string }>;
  forkAndResume(
    traceId: string,
    forkFromSpanId: string,
    overrides?: { promptText?: string },
    options?: {
      command?: string | string[];
      projectConfigYaml?: string;
      projectRoot?: string;
      virtualEnv?: string;
      executablePath?: string;
      mode?: "fork" | "record";
    }
  ): Promise<ForkAndResumeResponse>;
  getRuntimeMetadata(traceId: string): Promise<{
    traceId?: string;
    projectRoot?: string;
    virtualEnv?: string | null;
    executablePath?: string | null;
    entrypoint?: string | null;
    command?: string[] | null;
    cassetteRunId?: string | null;
    hasCassette?: boolean;
  } | null>;
  getProjectConfig(): Promise<{ config: any }>;
  saveProjectConfig(payload: { yamlContent?: string; command?: string | string[] }): Promise<{ ok: boolean; path: string }>;
};

export function createApi(
  baseUrl = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_COLLECTOR_URL) || DEFAULT_COLLECTOR,
  orchestratorUrl = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_ORCHESTRATOR_URL) || DEFAULT_ORCHESTRATOR
): Api {
  const base = baseUrl.replace(/\/$/, "");
  const orchBase = orchestratorUrl.replace(/\/$/, "");

  return {
    async listTraces(filters) {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set("projectId", filters.projectId);
      if (filters?.environment) params.set("environment", filters.environment);
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${base}/v1/traces${queryString}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceListResponseSchema.parse(json) as TraceListResponse;
    },

    async getTrace(traceId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceWithMetaSchema.parse(json) as TraceWithMeta;
    },

    async forkTrace(traceId, body) {
      const validated = traceForkRequestSchema.parse(body) as TraceForkRequest;
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validated)
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceForkResponseSchema.parse(json) as TraceForkResponse;
    },

    async getLineage(traceId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/lineage`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceLineageGraphSchema.parse(json) as TraceLineageGraph;
    },

    async getDiff(aId, bId) {
      const res = await fetch(
        `${base}/v1/traces/${encodeURIComponent(aId)}/diff/${encodeURIComponent(bId)}`
      );
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceDiffResultSchema.parse(json) as TraceDiffResult;
    },

    async getAnalysis(traceId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/analysis`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceAnalysisSchema.parse(json) as TraceAnalysis;
    },

    async getStats(traceId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/stats`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return traceStatsSchema.parse(json) as TraceStats;
    },

    async deleteTrace(traceId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(await res.text());
    },

    async replayTrace(traceId, cassetteRunId) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cassetteRunId })
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    async getRun(runId) {
      const res = await fetch(`${orchBase}/v1/runs/${encodeURIComponent(runId)}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return getRunResponseSchema.parse(json) as GetRunResponse;
    },

    async cancelRun(runId: string) {
      const res = await fetch(`${orchBase}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST"
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    async getProjectConfig() {
      try {
        const res = await fetch(`${base}/v1/project/config`);
        if (!res.ok) return { config: null };
        return await res.json();
      } catch {
        return { config: null };
      }
    },

    async saveProjectConfig(payload) {
      const res = await fetch(`${base}/v1/project/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    async getRuntimeMetadata(traceId: string) {
      try {
        const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/runtime-metadata`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },

    async forkAndResume(traceId, forkFromSpanId, overrides, options) {
      const res = await fetch(`${base}/v1/traces/${encodeURIComponent(traceId)}/fork-and-resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          forkFromSpanId,
          overrides,
          command: options?.command,
          projectConfigYaml: options?.projectConfigYaml,
          projectRoot: options?.projectRoot,
          virtualEnv: options?.virtualEnv,
          executablePath: options?.executablePath,
          mode: options?.mode
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return forkAndResumeResponseSchema.parse(json) as ForkAndResumeResponse;
    }
  };
}

