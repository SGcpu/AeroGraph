import time
import uuid

from aerograph_langchain.streaming import StreamingTracker


def test_streaming_tracker():
    tracker = StreamingTracker()
    run_id = uuid.uuid4()

    # Start LLM
    tracker.on_llm_start(run_id)
    time.sleep(0.01)

    # First token
    tracker.on_llm_new_token(run_id)
    time.sleep(0.02)

    # Second token
    tracker.on_llm_new_token(run_id)

    telemetry = tracker.on_llm_end(run_id)

    assert telemetry is not None
    assert telemetry["tokenCount"] == 2
    assert telemetry["timeToFirstTokenMs"] > 0
    assert telemetry["totalDurationMs"] > telemetry["timeToFirstTokenMs"]
    assert telemetry["tokensPerSecond"] > 0


def test_streaming_tracker_no_tokens():
    tracker = StreamingTracker()
    run_id = uuid.uuid4()

    tracker.on_llm_start(run_id)
    time.sleep(0.01)

    telemetry = tracker.on_llm_end(run_id)

    assert telemetry is None
