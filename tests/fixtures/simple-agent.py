import os
import sys
import urllib.request
from aerograph_sdk import FlightRecorder, new_trace_id

def main():
    collector_url = os.environ.get("AEROGRAPH_COLLECTOR_URL", "http://localhost:4317")
    trace_id = os.environ.get("AFR_TRACE_ID", new_trace_id())
    
    recorder = FlightRecorder(
        endpoint=collector_url,
        actor={"id": "simple-agent", "type": "agent"},
        trace_id=trace_id,
    )
    
    prompt_span_id = recorder.prompt(
        content="What is the weather in Tokyo?",
        metadata={"role": "user"}
    )
    
    # Perform HTTP request (which will be intercepted by the proxy if running under replay-core)
    url = "https://httpbin.org/get"
    req = urllib.request.Request(url, headers={"X-AeroGraph-Span-Id": prompt_span_id})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            body = response.read().decode("utf-8")
    except Exception as e:
        body = f"fallback: {e}"

    recorder.model_response(
        parent_span_id=prompt_span_id,
        content=f"Processed response: {body[:50]}",
        model="gpt-4o"
    )
    
    recorder.flush()
    print("simple-agent execution completed successfully.")

if __name__ == "__main__":
    main()
