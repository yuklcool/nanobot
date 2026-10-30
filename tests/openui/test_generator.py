"""A UI request uses frozen turn settings without a business tool surface."""

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
