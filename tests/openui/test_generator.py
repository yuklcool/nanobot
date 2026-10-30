"""A UI request uses frozen turn settings without a business tool surface."""

import json

from nanobot.openui.data import SessionQuery, TableAdapterConfig, capture_table
from nanobot.openui.generator import generate_view
from nanobot.providers.base import GenerationSettings, LLMProvider, LLMResponse
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
        query="项目规划", exclude_session_key="websocket:private-current-session",
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
    assert payload["datasets"][1]["source_tool"] == "search_sessions"
    assert payload["datasets"][1]["captured_at"] == tables[1].captured_at
    for private in ["internal-id", "Authorized cell", "PRIVATE-FIELD", "private-current-session"]:
        assert private not in json.dumps(payload)
