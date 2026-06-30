import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLangChainHandler } from "../src/handler";
import type { FlightRecorder, TelemetryBlock } from "@aerograph/sdk";

describe("Telemetry Normalization Parity Test", () => {
  let mockRecorder: FlightRecorder;
  let mockResponse: any;
  let mockNote: any;

  beforeEach(() => {
    mockResponse = vi.fn();
    mockNote = vi.fn();

    // Mock the FlightRecorder interface
    mockRecorder = {
      response: mockResponse,
      note: mockNote,
    } as unknown as FlightRecorder;
  });

  it("should normalize model and token usage into response telemetry", async () => {
    const handler = createLangChainHandler({ recorder: mockRecorder });

    const llmOutput = {
      model_name: "gpt-4o",
      tokenUsage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };

    const output = {
      generations: [[{ text: "Hello world" }]],
      llmOutput,
    };

    await handler.handleLLMEnd(output, "run-1");

    // Verify absence of telemetry note events
    expect(mockNote).not.toHaveBeenCalled();

    // Verify mapper usage path inside response event
    expect(mockResponse).toHaveBeenCalledTimes(1);
    const responseCall = mockResponse.mock.calls[0][0];

    expect(responseCall.parentSpanId).toBe("run-1");
    expect(responseCall.text).toBe("Hello world");

    // Verify identical model normalization and token normalization
    const telemetry: TelemetryBlock = responseCall.telemetry;
    expect(telemetry).toBeDefined();
    expect(telemetry.model).toEqual({ name: "gpt-4o" });
    expect(telemetry.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  it("should not crash if llmOutput is missing (backward compatibility)", async () => {
    const handler = createLangChainHandler({ recorder: mockRecorder });

    const output = {
      generations: [[{ text: "Hello world without metadata" }]],
      // No llmOutput
    };

    await handler.handleLLMEnd(output, "run-2");

    expect(mockNote).not.toHaveBeenCalled();
    expect(mockResponse).toHaveBeenCalledTimes(1);
    const responseCall = mockResponse.mock.calls[0][0];

    expect(responseCall.parentSpanId).toBe("run-2");
    expect(responseCall.text).toBe("Hello world without metadata");
    
    // Telemetry might be undefined or empty but it won't crash
    if (responseCall.telemetry) {
      expect(responseCall.telemetry.model).toBeUndefined();
      expect(responseCall.telemetry.usage).toBeUndefined();
    }
  });

  it("should map partial token usage correctly", async () => {
    const handler = createLangChainHandler({ recorder: mockRecorder });

    const llmOutput = {
      model_name: "claude-3",
      tokenUsage: {
        prompt_tokens: 10,
        // no completion or total tokens
      },
    };

    const output = {
      generations: [[{ text: "Hello partial" }]],
      llmOutput,
    };

    await handler.handleLLMEnd(output, "run-3");

    const responseCall = mockResponse.mock.calls[0][0];
    expect(responseCall.telemetry.usage.inputTokens).toBe(10);
    expect(responseCall.telemetry.usage.totalTokens).toBe(10); // Derived via generic mapper
  });
});
