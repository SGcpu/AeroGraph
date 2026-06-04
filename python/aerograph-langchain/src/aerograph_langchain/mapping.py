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
)
from aerograph_sdk.contracts.generated import (
    PromptEvent,
    ResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
    TraceEvent,
)
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

    return build_response_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id=actor_name,
        actor_name=actor_name,
        title=actor_name,
        text=text,
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
    
    return build_error_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        message=str(error),
        actor_id="langchain",
        actor_name="LangChain",
    )
