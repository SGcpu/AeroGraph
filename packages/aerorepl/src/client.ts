import type {
  StartRunRequest,
  StartRunResponse,
  GetRunResponse,
  ForkAndResumeResponse,
  TraceEvent
} from "@aerograph/contracts";

export class AereplError extends Error {
  constructor(
    public status: number,
    public body: any,
    message?: string
  ) {
    super(
      message ||
        `Aerepl HTTP Error ${status}: ${
          typeof body === "object" ? JSON.stringify(body) : String(body)
        }`
    );
    this.name = "AereplError";
  }
}

export interface SessionInfo {
  sessionId: string;
  runId: string;
  traceId: string;
  currentStep: number;
  overrides: Record<string, any>;
}

export interface StepResult {
  step: number;
  spanSummary: {
    spanId: string;
    kind: string;
    status?: string;
  } | null;
}

export class AereplClient {
  constructor(
    public orchestratorUrl: string = "http://127.0.0.1:4318",
    public collectorUrl: string = "http://127.0.0.1:4317"
  ) {}

  private async request<T>(
    baseUrl: string,
    pathname: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, "")}${pathname}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {})
    };

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers
      });
    } catch (err: any) {
      throw new AereplError(0, null, `Network error connecting to ${url}: ${err.message}`);
    }

    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new AereplError(
        res.status,
        body,
        `Request to ${pathname} failed with status ${res.status}: ${JSON.stringify(body)}`
      );
    }

    return body as T;
  }

  async startRun(req: StartRunRequest): Promise<StartRunResponse> {
    return this.request<StartRunResponse>(this.orchestratorUrl, "/v1/runs", {
      method: "POST",
      body: JSON.stringify(req)
    });
  }

  async getRun(runId: string): Promise<GetRunResponse> {
    return this.request<GetRunResponse>(this.orchestratorUrl, `/v1/runs/${runId}`, {
      method: "GET"
    });
  }

  async cancelRun(runId: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(
      this.orchestratorUrl,
      `/v1/runs/${runId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  }

  async listRuns(): Promise<GetRunResponse[]> {
    return this.request<GetRunResponse[]>(this.orchestratorUrl, "/v1/runs", {
      method: "GET"
    });
  }

  async listTraces(projectId?: string): Promise<{ traces: any[] }> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return this.request<{ traces: any[] }>(this.collectorUrl, `/v1/traces${qs}`, {
      method: "GET"
    });
  }

  async getTrace(traceId: string): Promise<{ meta: any; events: TraceEvent[] }> {
    return this.request<{ meta: any; events: TraceEvent[] }>(
      this.collectorUrl,
      `/v1/traces/${encodeURIComponent(traceId)}`,
      { method: "GET" }
    );
  }

  async getDiff(aId: string, bId: string): Promise<any> {
    return this.request<any>(
      this.collectorUrl,
      `/v1/traces/${encodeURIComponent(aId)}/diff/${encodeURIComponent(bId)}`,
      { method: "GET" }
    );
  }

  async getProjectConfig(projectId?: string, projectRoot?: string): Promise<{ config: any; projectRoot?: string }> {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (projectRoot) params.set("projectRoot", projectRoot);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ config: any; projectRoot?: string }>(
      this.collectorUrl,
      `/v1/project/config${qs}`,
      { method: "GET" }
    );
  }

  async saveProjectConfig(payload: {
    yamlContent?: string;
    command?: string[];
    projectId?: string;
    projectRoot?: string;
  }): Promise<{ ok: boolean; path: string }> {
    return this.request<{ ok: boolean; path: string }>(
      this.collectorUrl,
      "/v1/project/config",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );
  }

  async getInputWait(runId: string): Promise<{ waiting: boolean; turn: number | null; prompt: string | null }> {
    try {
      return await this.request<{ waiting: boolean; turn: number | null; prompt: string | null }>(
        this.orchestratorUrl,
        `/v1/runs/${encodeURIComponent(runId)}/input-wait`,
        { method: "GET" }
      );
    } catch {
      return { waiting: false, turn: null, prompt: null };
    }
  }

  async submitInput(runId: string, turn: number, payload: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      this.orchestratorUrl,
      `/v1/runs/${encodeURIComponent(runId)}/input-submit`,
      {
        method: "POST",
        body: JSON.stringify({ turn, payload })
      }
    );
  }

  async createSession(runId: string): Promise<{ sessionId: string; runId: string; status: string }> {
    return this.request<{ sessionId: string; runId: string; status: string }>(
      this.orchestratorUrl,
      "/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ runId })
      }
    );
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>(this.orchestratorUrl, `/v1/sessions/${sessionId}`, {
      method: "GET"
    });
  }

  async stepSession(sessionId: string): Promise<StepResult> {
    return this.request<StepResult>(
      this.orchestratorUrl,
      `/v1/sessions/${sessionId}/step`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  }

  async overrideSpan(
    sessionId: string,
    spanId: string,
    value: any
  ): Promise<{ ok: boolean; spanId: string; overridden: boolean }> {
    return this.request<{ ok: boolean; spanId: string; overridden: boolean }>(
      this.orchestratorUrl,
      `/v1/sessions/${sessionId}/override`,
      {
        method: "POST",
        body: JSON.stringify({ spanId, value })
      }
    );
  }

  async rewindSession(
    sessionId: string,
    steps: number = 1
  ): Promise<{ newTraceId: string; sessionId: string; currentStep: number }> {
    return this.request<{ newTraceId: string; sessionId: string; currentStep: number }>(
      this.orchestratorUrl,
      `/v1/sessions/${sessionId}/rewind`,
      {
        method: "POST",
        body: JSON.stringify({ steps })
      }
    );
  }

  async inspectSpan(traceId: string, spanId: string): Promise<TraceEvent> {
    return this.request<TraceEvent>(
      this.collectorUrl,
      `/v1/traces/${traceId}/events/${spanId}`,
      {
        method: "GET"
      }
    );
  }

  async forkFromSpan(
    traceId: string,
    forkFromSpanId: string,
    promptText?: string,
    projectRoot?: string,
    command?: string[]
  ): Promise<ForkAndResumeResponse> {
    return this.request<ForkAndResumeResponse>(
      this.collectorUrl,
      `/v1/traces/${traceId}/fork-and-resume`,
      {
        method: "POST",
        body: JSON.stringify({
          forkFromSpanId,
          overrides: promptText ? { promptText } : undefined,
          projectRoot: projectRoot || process.cwd(),
          command
        })
      }
    );
  }
}
