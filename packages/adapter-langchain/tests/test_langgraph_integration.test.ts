import { test } from "vitest";
import { StateGraph, START, END } from "@langchain/langgraph/web";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { createLangChainHandler, createLangGraphHandler } from "../src";
import { FlightRecorder } from "@aerograph/sdk";

test("Integration Test with LangGraph", async () => {
  // Initialize AeroGraph recorder
  const recorder = new FlightRecorder({
    projectId: "test-js-langgraph",
    endpoint: "http://localhost:5173",
    actor: { id: "test-js-langgraph", name: "Test Script" }
  });

  const langchainHandler = createLangChainHandler({ recorder });
  const langgraphHandler = createLangGraphHandler({ recorder });

  // Define LangGraph state
  interface AgentState {
    messages: BaseMessage[];
  }

  // Simple echo node using mock LLM
  async function echoNode(state: AgentState, config: any) {
    const lastMessage = state.messages[state.messages.length - 1];
    
    // Simulate LLM call using mock message to avoid needing API keys
    const response = new AIMessage({
      content: `Echo: ${lastMessage.content}`,
    });

    return { messages: [response] };
  }

  // Define graph
  const workflow = new StateGraph<AgentState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      }
    }
  });

  workflow.addNode("echo", echoNode);
  workflow.addEdge(START, "echo");
  workflow.addEdge("echo", END);

  const app = workflow.compile();

  // Run the graph
  await app.invoke(
    { messages: [new HumanMessage("Hello LangGraph TS!")] },
    { callbacks: [langchainHandler, langgraphHandler] }
  );

  // Wait a moment for network dispatch
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("Graph executed successfully.");
});
