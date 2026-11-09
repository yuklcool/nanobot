"""A UI request uses frozen turn settings without a business tool surface."""

import json

import pytest
from loguru import logger

from nanobot.openui.data import SessionQuery, TableAdapterConfig, capture_table
from nanobot.openui.generator import UiGenerationError, generate_view
from nanobot.providers.base import (
    GenerationSettings,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    ToolCallRequest,
)
from nanobot.utils.llm_runtime import LLMRuntime


class RecordingProvider(LLMProvider):
    def get_default_model(self):
        return "current-default"

    async def chat(self, messages, **kwargs):
        raise AssertionError("UI must use the captured streaming request")

    async def chat_stream(self, messages, on_content_delta=None, **kwargs):
        self.request = (messages, kwargs)
        await on_content_delta('root = Panel([text])\ntext = Text("Public answer")\n')
        return LLMResponse(content="", tool_calls=[])


async def test_uses_frozen_model_generation_and_bounded_output():
    provider = RecordingProvider(provider_name="fixture")
    provider.generation = GenerationSettings(temperature=0.2, max_tokens=1024, reasoning_effort="low")
    runtime = LLMRuntime.capture(provider, "selected-model", context_window_tokens=8192)
    provider.generation = GenerationSettings(temperature=0.9, max_tokens=8192, reasoning_effort="high")
    output = []

    async def emit(delta):
        output.append(delta)

    await generate_view(runtime=runtime, answer="Public answer", tables={}, library_prompt="Library contract",
                        max_tokens=512, emit=emit)
    messages, params = provider.request
    assert params["model"] == "selected-model"
    assert params["max_tokens"] == 512 and params["temperature"] == 0.2
    assert params["reasoning_effort"] == "low" and params["tools"] is None
    assert len(messages) == 2 and "Public answer" in messages[1]["content"]
    assert output == ['root = Panel([text])\ntext = Text("Public answer")\n']


async def test_data_candidates_keep_public_context_and_provenance_without_raw_results():
    provider = RecordingProvider(provider_name="fixture")
    runtime = LLMRuntime.capture(provider, "selected-model", context_window_tokens=8192)
    adapter = TableAdapterConfig(title="相关会话", columns={"title": "标题"})
    tables = [capture_table(adapter, tool_name="search_sessions", call_id=str(index),
                            result=json.dumps({"records": records})) for index, records in enumerate([
        [], [{"id": "internal-id", "title": "Authorized cell", "secret": "PRIVATE-FIELD"}],
    ])]
    tables[0] = tables[0].model_copy(update={"session_query": SessionQuery(
        query="项目规划", exclude_session_key="websocket:private-current-session", session_keys=[],
    )})

    async def emit(delta):
        pass

    question = "查找项目规划的会话，只显示最终相关结果。"
    answer = "首次搜索没有结果，换词后找到一条相关会话。"
    await generate_view(runtime=runtime, question=question, answer=answer,
                        tables={table.data_ref: table for table in tables}, library_prompt="Library contract",
                        max_tokens=512, emit=emit)
    payload = json.loads(provider.request[0][-1]["content"])
    assert payload["question"] == question and payload["public_answer"] == answer
    assert [item["row_count"] for item in payload["datasets"]] == [0, 1]
    assert payload["datasets"][0]["search_query"] == "项目规划"
    assert payload["datasets"][0]["selection_applied"] is True
    assert payload["datasets"][1]["source_tool"] == "search_sessions"
    assert payload["datasets"][1]["captured_at"] == tables[1].captured_at
    for private in ["internal-id", "Authorized cell", "PRIVATE-FIELD", "private-current-session"]:
        assert private not in json.dumps(payload)


@pytest.fixture
def generation_logs():
    records = []
    sink = logger.add(lambda message: records.append(message.record["extra"]),
                      filter=lambda record: record["extra"].get("event") == "openui_model_completed")
    try:
        yield records
    finally:
        logger.remove(sink)


@pytest.mark.parametrize("partial", [False, True])
async def test_provider_timeout_retries_only_before_any_ui_output(partial, monkeypatch, generation_logs):
    class InterruptedProvider(RecordingProvider):
        calls = 0

        async def chat_stream(self, messages, on_content_delta=None, **kwargs):
            self.calls += 1
            if self.calls == 1:
                if partial:
                    await on_content_delta('root = Panel([text])\n')
                return LLMResponse(content="temporary timeout", finish_reason="error", error_kind="timeout")
            await on_content_delta('root = Panel([])\n')
            return LLMResponse(content='root = Panel([])\n', usage=LLMUsage.reported(input_tokens=10, output_tokens=5))

    provider = InterruptedProvider(provider_name="fixture")
    monkeypatch.setattr(provider, "_CHAT_RETRY_DELAYS", [0.001])
    runtime = LLMRuntime.capture(provider, "selected-model", context_window_tokens=8192)
    output = []

    async def emit(text):
        output.append(text)

    if partial:
        with pytest.raises(UiGenerationError, match="UI_STREAM_INTERRUPTED"):
            await generate_view(runtime=runtime, answer="Public answer", tables={}, library_prompt="Library",
                                max_tokens=512, emit=emit)
        assert provider.calls == 1 and output == ['root = Panel([text])\n']
        assert generation_logs[-1]["error_code"] == "UI_STREAM_INTERRUPTED"
        output.clear()
    await generate_view(runtime=runtime, answer="Public answer", tables={}, library_prompt="Library",
                        max_tokens=512, emit=emit)
    assert provider.calls == 2 and output == ['root = Panel([])\n']
    record = generation_logs[-1]
    assert record["status"] == "complete" and record["first_delta_ms"] is not None
    assert record["retry_waits"] == (0 if partial else 1)
    assert record["total_tokens"] == 15 and record["duration_ms"] >= record["first_delta_ms"]


@pytest.mark.parametrize(("response", "code"), [
    (LLMResponse(content="PRIVATE-ERROR", finish_reason="error", error_status_code=400), "UI_PROVIDER_ERROR"),
    (LLMResponse(content="partial", finish_reason="length"), "UI_OUTPUT_TRUNCATED"),
    (LLMResponse(content="", tool_calls=[ToolCallRequest(id="forged", name="lookup", arguments={})]), "UI_UNEXPECTED_TOOL_CALL"),
])
async def test_failure_diagnostics_do_not_record_provider_payload(response, code, generation_logs):
    class FailedProvider(RecordingProvider):
        async def chat_stream(self, messages, on_content_delta=None, **kwargs):
            await on_content_delta('root = Panel([])\n')
            return response

    async def emit(text):
        pass

    runtime = LLMRuntime.capture(FailedProvider(provider_name="fixture"), "selected-model", context_window_tokens=8192)
    with pytest.raises(UiGenerationError, match=code):
        await generate_view(runtime=runtime, answer="PRIVATE-ANSWER", question="PRIVATE-QUESTION", tables={},
                            library_prompt="Library", max_tokens=512, emit=emit)
    record = generation_logs[-1]
    assert record["status"] == "failed" and record["error_code"] == code
    assert not any(value in json.dumps(record) for value in ("PRIVATE-ERROR", "PRIVATE-ANSWER", "PRIVATE-QUESTION"))
