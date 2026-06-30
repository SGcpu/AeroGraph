import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { type FlightRecorder, buildCanonicalTelemetry } from "@aerograph/sdk";

export interface LangChainHandlerOptions {
  recorder: FlightRecorder;
}

export function createLangChainHandler(options: LangChainHandlerOptions) {
  return new AFRCallbackHandler(options.recorder);
}

/**
 * Extracts clean, human-readable text from LangChain generation arrays.
 * Flattens nested arrays and joins individual generation texts with newlines.
 */
function extractResponseText(generations: any[][]): string {
  return generations
    .flatMap((group) => group.map((item: any) => item.text || item.message?.content || ""))
    .filter(Boolean)
    .join("\n");
}

export class AFRCallbackHandler extends BaseCallbackHandler {
  name = "AFRCallbackHandler";

  private readonly toolRunMeta = new Map<string, { toolId: string; toolName?: string }>();

  constructor(private recorder: FlightRecorder) {
    super();
  }

  // ── LLM Events ──────────────────────────────────────────────────────────────

  async handleLLMStart(
    _llm: any,
    prompts: string[],
    runId: string,
    parentRunId?: string
  ) {
    // Fix (I1): use actual newline character, not the two-char sequence \n
    await this.recorder.prompt({
      parentSpanId: parentRunId || null,
      spanId: runId,
      text: prompts.join("\n")
    });
  }

  async handleLLMEnd(output: any, runId: string) {
    const generations: any[][] = output.generations || [];
    const text = extractResponseText(generations);

    // Extract optional token usage metadata from llmOutput if present
    const llmOutput = output.llmOutput || {};
    const tokenUsage = llmOutput.tokenUsage || llmOutput.usage || null;
    const modelName = llmOutput.model_name || llmOutput.modelName || null;

    // Use generic mapper for standard canonical telemetry
    const telemetry = buildCanonicalTelemetry({
      model: modelName ? { name: modelName } : undefined,
      usage: tokenUsage || undefined,
    });

    await this.recorder.response({
      parentSpanId: runId,
      text,
      telemetry
    });
  }

  async handleLLMError(err: any, runId: string) {
    await this.recorder.error({
      parentSpanId: runId,
      message: err?.message || String(err)
    });
  }

  // ── Chain Events (nested sub-chain tracing) ─────────────────────────────────

  async handleChainStart(
    chain: any,
    _inputs: any,
    runId: string,
    parentRunId?: string
  ) {
    const chainName = chain?.name || chain?.id?.[chain.id?.length - 1] || "chain";
    await this.recorder.note({
      parentSpanId: parentRunId || null,
      spanId: runId,
      payload: { event: "chain_start", chainName }
    });
  }

  async handleChainEnd(outputs: any, runId: string) {
    await this.recorder.note({
      parentSpanId: runId,
      payload: { event: "chain_end", outputKeys: Object.keys(outputs || {}) }
    });
  }

  async handleChainError(err: any, runId: string) {
    await this.recorder.error({
      parentSpanId: runId,
      message: err?.message || String(err)
    });
  }

  // ── Tool Events ──────────────────────────────────────────────────────────────

  async handleToolStart(
    tool: any,
    input: string,
    runId: string,
    parentRunId?: string
  ) {
    const toolId = tool?.id?.[tool.id.length - 1] || tool?.name || `tool_run_${runId}`;
    const toolName = tool?.name;
    this.toolRunMeta.set(runId, { toolId, toolName });

    await this.recorder.toolCall({
      parentSpanId: parentRunId || null,
      spanId: runId,
      toolId,
      toolName,
      input: { input }
    });
  }

  async handleToolEnd(output: any, runId: string) {
    const meta = this.toolRunMeta.get(runId);
    const toolId = meta?.toolId ?? `tool_run_${runId}`;
    const toolName = meta?.toolName;

    await this.recorder.toolResult({
      parentSpanId: runId,
      toolId,
      toolName,
      output: { output }
    });

    this.toolRunMeta.delete(runId);
  }

  async handleToolError(err: any, runId: string) {
    this.toolRunMeta.delete(runId);
    await this.recorder.error({
      parentSpanId: runId,
      message: err?.message || String(err)
    });
  }
}
