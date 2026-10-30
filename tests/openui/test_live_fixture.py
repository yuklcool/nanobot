"""Offline checks for the opt-in live acceptance fixture's isolation boundary."""

import json

import pytest
from gateway_fixture import LiveEvidence, isolated_live_config

from nanobot.config.schema import Config
from nanobot.llm_usage.models import LLMCallRecord
from nanobot.providers.base import LLMUsage


def test_live_config_keeps_selected_provider_but_isolates_runtime(tmp_path):
    source = Config.model_validate({
        "agents": {"defaults": {"workspace": "/private/workspace", "modelPreset": "chosen",
                                  "fallbackModels": ["chosen"]}},
        "modelPresets": {"chosen": {"model": "live-model", "provider": "openai", "maxTokens": 2048}},
        "providers": {"openai": {"apiKey": "test-secret", "apiBase": "https://example.test/v1"}},
        "channels": {"websocket": {"enabled": True, "port": 8765}},
        "tools": {"mcpServers": {"private": {"command": "private-command"}}},
    })
    path = tmp_path / "source.json"
    path.write_text(source.model_dump_json(by_alias=True), encoding="utf-8")
    workspace = tmp_path / "isolated"
    isolated = isolated_live_config(path, workspace)
    assert isolated.resolve_preset() == source.resolve_preset()
    assert isolated.providers.openai.api_key == "test-secret"
    assert isolated.agents.defaults.workspace == str(workspace)
    assert isolated.agents.defaults.fallback_models == []
    assert not isolated.channels.model_extra
    assert not isolated.tools.mcp_servers
    with pytest.raises(ValueError, match="LIVE_CONFIG_REQUIRED"):
        isolated_live_config(tmp_path / "missing.json", workspace)


def test_live_evidence_records_physical_calls_without_request_content(tmp_path):
    path = tmp_path / "evidence.json"
    evidence = LiveEvidence(path)
    evidence.observe(LLMCallRecord(
        started_at_ms=1, duration_ms=123, provider="openai", model="live-model",
        source="user", stream=True, finish_reason="stop",
        usage=LLMUsage.reported(input_tokens=10, output_tokens=5),
    ))
    report = json.loads(path.read_text())
    assert report["calls"][0]["duration_ms"] == 123
    assert report["calls"][0]["usage"]["total_tokens"] == 15
    assert report["tools"] == []
