import uuid
from langchain_core.documents import Document

from aerograph_langchain.retriever import RetrieverTracker
from aerograph_sdk.contracts.generated import RetrieverEvent
from aerograph_langchain.span_ids import derive_span_id


def test_retriever_tracker():
    tracker = RetrieverTracker()
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()
    trace_id = "t_123"

    tracker.on_retriever_start(
        run_id=run_id, query="search query", serialized={"name": "VectorStoreRetriever"}
    )

    docs = [
        Document(page_content="doc1", metadata={"source": "test.txt", "score": 0.95})
    ]

    event = tracker.on_retriever_end(
        run_id=run_id, documents=docs, trace_id=trace_id, parent_run_id=parent_run_id
    )

    assert isinstance(event, RetrieverEvent)
    assert event.traceId == trace_id
    assert event.spanId == derive_span_id(run_id)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        parent_run_id
    )
    assert event.payload.query == "search query"
    assert len(event.payload.documents) == 1
    assert event.payload.documents[0].pageContent == "doc1"
    assert event.payload.documents[0].metadata == {"source": "test.txt", "score": 0.95}
    assert event.payload.documents[0].score == 0.95
