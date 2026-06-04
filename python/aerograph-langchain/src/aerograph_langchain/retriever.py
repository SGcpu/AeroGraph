import uuid
from typing import Any, Dict, List, Optional
from langchain_core.documents import Document

from aerograph_sdk.events import build_retriever_event
from aerograph_sdk.contracts.generated import RetrieverEvent
from aerograph_langchain.span_ids import derive_span_id


class RetrieverTracker:
    def __init__(self):
        self._queries: Dict[uuid.UUID, Dict[str, Any]] = {}

    def on_retriever_start(
        self, run_id: uuid.UUID, query: str, serialized: Dict[str, Any]
    ) -> None:
        self._queries[run_id] = {"query": query, "serialized": serialized}

    def on_retriever_end(
        self,
        run_id: uuid.UUID,
        documents: List[Document],
        trace_id: str,
        parent_run_id: Optional[uuid.UUID] = None,
    ) -> Optional[RetrieverEvent]:
        state = self._queries.pop(run_id, None)
        if not state:
            return None

        query = state["query"]
        serialized = state["serialized"]
        actor_name = serialized.get("name", "UnknownRetriever")

        span_id = derive_span_id(run_id)
        parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

        docs = []
        for d in documents:
            doc_dict = {
                "pageContent": d.page_content,
                "metadata": d.metadata,
                "score": d.metadata.get("score")
                if isinstance(d.metadata, dict)
                else None,
            }
            docs.append(doc_dict)

        return build_retriever_event(
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            tool_id=actor_name,
            tool_name=actor_name,
            query=query,
            documents=docs,
        )
