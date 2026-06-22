import uuid
import json
from typing import Any, Dict, List, Optional, Union
from langchain_core.outputs import LLMResult
from langchain_core.messages import BaseMessage

from aerograph_sdk.events import (
    build_prompt_event,
    build_response_event,
    build_tool_call_event,
    build_tool_result_event,
    build_error_event,
    build_note_event,
)
from aerograph_sdk.contracts.generated import (
    PromptEvent,
    ResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
    NoteEvent,
    TraceEvent,
)
from aerograph_sdk.telemetry.mapper import TelemetryBlock, map_model_info, map_usage
from aerograph_langchain.span_ids import derive_span_id


def _get_actor_name(serialized: Dict[str, Any]) -> str:
    return serialized.get("name", "Unknown")


def _messages_to_text(messages: List[List[BaseMessage]]) -> str:
    texts = []
    for message_list in messages:
        for msg in message_list:
            if isinstance(msg.content, str):
                texts.append(f"{msg.type}: {msg.content}")
            else:
                texts.append(f"{msg.type}: {json.dumps(msg.content)}")
    return "\n".join(texts)


def map_llm_start(
    serialized: Dict[str, Any],
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
    prompts: Optional[List[str]] = None,
    messages: Optional[List[List[BaseMessage]]] = None,
) -> PromptEvent:
    actor_name = _get_actor_name(serialized)
    span_id = derive_span_id(run_id)
    parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

    if messages:
        text = _messages_to_text(messages)
    elif prompts:
        text = "\n".join(prompts)
    else:
        text = ""

    return build_prompt_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id=actor_name,
        actor_name=actor_name,
        title=actor_name,
        text=text,
    )


def map_llm_end(
    serialized: Dict[str, Any],
    response: LLMResult,
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
) -> ResponseEvent:
    actor_name = _get_actor_name(serialized)
    # response is the child of prompt.
    prompt_span_id = derive_span_id(run_id)
    # the parent of response is the prompt span
    parent_span_id = prompt_span_id
    span_id = prompt_span_id + "_end"  # Just append _end to guarantee uniqueness

    text = ""
    if response.generations:
        for gen_list in response.generations:
            for gen in gen_list:
                text += gen.text + "\n"
    text = text.strip()

    llm_output = response.llm_output or {}
    model_name = llm_output.get("model_name") or llm_output.get("modelName")
    token_usage = llm_output.get("token_usage") or llm_output.get("tokenUsage")

    model_info = map_model_info({"name": model_name}) if model_name else None
    usage_info = map_usage(token_usage) if token_usage else None
    telemetry = TelemetryBlock(model=model_info, usage=usage_info) if (model_info or usage_info) else None

    return build_response_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id=actor_name,
        actor_name=actor_name,
        title=actor_name,
        text=text,
        telemetry=telemetry,
    )


def map_tool_start(
    serialized: Dict[str, Any],
    input_str: str,
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
    inputs: Optional[Dict[str, Any]] = None,
) -> ToolCallEvent:
    actor_name = _get_actor_name(serialized)
    span_id = derive_span_id(run_id)
    parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

    payload_input = inputs if inputs is not None else {"input": input_str}

    return build_tool_call_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        tool_id=actor_name,
        tool_name=actor_name,
        title=actor_name,
        input=payload_input,
    )


def map_tool_end(
    serialized: Dict[str, Any],
    output: Any,
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
) -> ToolResultEvent:
    actor_name = _get_actor_name(serialized)
    tool_call_span_id = derive_span_id(run_id)
    parent_span_id = tool_call_span_id
    span_id = tool_call_span_id + "_end"

    if not isinstance(output, dict):
        payload_output = {"output": output}
    else:
        payload_output = output

    return build_tool_result_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        tool_id=actor_name,
        tool_name=actor_name,
        title=actor_name,
        output=payload_output,
    )

def map_error(
    error: Union[Exception, KeyboardInterrupt],
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
) -> TraceEvent:
    # An error is typically a child of the span that failed, 
    # but in our schema, error events can just hang off the failing span's parent,
    # or be the failing span itself. 
    # To maintain append-only semantics, we emit a new error event whose parent is the failing run's span.
    # Wait, if we use the failing run's span as parent, it works beautifully.
    span_id = derive_span_id(run_id) + "_error"
    parent_span_id = derive_span_id(run_id)
    
    error_msg = str(error).strip()
    if not error_msg:
        error_msg = type(error).__name__ or "Unknown error"

    return build_error_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        message=error_msg,
        actor_id="langchain",
        actor_name="LangChain",
    )


def map_chain_start(
    serialized: Optional[Dict[str, Any]],
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
    name: Optional[str] = None,
) -> NoteEvent:
    """Emit a note event for a chain/agent start so its spanId exists as a node."""
    span_id = derive_span_id(run_id)
    parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

    # Try to derive a human-readable name for the chain
    chain_name = name
    if not chain_name and serialized:
        chain_name = serialized.get("name") or serialized.get("id", ["chain"])[-1]
    
    chain_name = chain_name or "chain"

    return build_note_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id="langchain",
        actor_name="LangChain",
        title=chain_name,
        payload={"chain": chain_name},
    )


def map_chain_end(
    outputs: Dict[str, Any],
    run_id: uuid.UUID,
    trace_id: str,
    parent_run_id: Optional[uuid.UUID] = None,
) -> NoteEvent:
    span_id = derive_span_id(run_id) + "_end"
    parent_span_id = derive_span_id(run_id)
    
    output_keys = list(outputs.keys()) if isinstance(outputs, dict) else []
    
    return build_note_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id="langchain",
        actor_name="LangChain",
        title="chain_end",
        payload={"event": "chain_end", "outputKeys": output_keys},
    )
