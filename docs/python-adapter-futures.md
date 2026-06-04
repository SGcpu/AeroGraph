# Python Adapter Futures

This document tracks planned architecture for future Python framework adapters. No implementation exists yet.

## AutoGen

- Needs a custom hook to intercept Agent conversable messages.
- Should map group chat messages to `handoff` and `prompt/response`.

## CrewAI

- Needs a callback hook into Task execution.
- Should map Crew handoffs to `handoff` events.

## LlamaIndex

- Needs `CallbackManager` integration.
- Should map query engine nodes to `retriever` and `prompt/response`.
