import time
import uuid
from typing import Any, Dict, Optional


class StreamingTracker:
    def __init__(self):
        self._state: Dict[uuid.UUID, Dict[str, Any]] = {}

    def on_llm_start(self, run_id: uuid.UUID) -> None:
        self._state[run_id] = {
            "start_time": time.perf_counter(),
            "first_token_time": None,
            "token_count": 0,
        }

    def on_llm_new_token(self, run_id: uuid.UUID) -> None:
        if run_id not in self._state:
            return

        state = self._state[run_id]
        if state["first_token_time"] is None:
            state["first_token_time"] = time.perf_counter()

        state["token_count"] += 1

    def on_llm_end(self, run_id: uuid.UUID) -> Optional[Dict[str, Any]]:
        if run_id not in self._state:
            return None

        state = self._state.pop(run_id)

        if state["token_count"] == 0 or state["first_token_time"] is None:
            return None

        end_time = time.perf_counter()
        total_duration = end_time - state["start_time"]
        time_to_first_token = state["first_token_time"] - state["start_time"]

        # Avoid division by zero
        if total_duration > 0:
            tokens_per_second = state["token_count"] / total_duration
        else:
            tokens_per_second = 0.0

        return {
            "timeToFirstTokenMs": time_to_first_token * 1000,
            "totalDurationMs": total_duration * 1000,
            "tokensPerSecond": tokens_per_second,
            "tokenCount": state["token_count"],
        }
