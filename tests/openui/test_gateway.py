"""Real Gateway router, native Agent, durable UI and restart admission contracts."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.bus.queue import MessageBus
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.openui.collector import OpenUICollector
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.session.manager import SessionManager
from nanobot.session.webui_turns import WebuiTurnCoordinator, clear_websocket_turns
from nanobot.webui.gateway_services import build_gateway_services


class Lookup(Tool):
    name = "lookup"
    description = "Count a read-only lookup."
    read_only = True
    parameters = {"type": "object", "properties": {}}

    def __init__(self):
        self.calls = 0

    async def execute(self, **kwargs):
        self.calls += 1
        return f"Lookup result {self.calls}"


class Provider(LLMProvider):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.ui_calls = 0
        self.agent_calls = 0
        self.ui_requests = []
        self.ui_started = asyncio.Event()
        self.ui_gate = None
        self.ui_invalid_tool = False
        self.ui_stream_stalled = False

    async def chat_stream(self, messages, on_content_delta=None, **kwargs):
        if "Generate only OpenUI Lang" not in str(messages[0].get("content", "")):
            return await super().chat_stream(messages, on_content_delta=on_content_delta, **kwargs)
        self.ui_calls += 1
        self.ui_requests.append((messages, kwargs))
        datasets = json.loads(messages[-1]["content"])["datasets"]
        children = ["heading", *[f"table{i}" for i in range(len(datasets))], "followup"]
        prefix = '$question = ""\nroot = Panel([' + ", ".join(children) + '])\nheading = Text("Task overview")\n'
        if on_content_delta:
            await on_content_delta(prefix)
        self.ui_started.set()
        if self.ui_stream_stalled:
            return LLMResponse(content="stream timeout", finish_reason="error", error_kind="timeout")
        if self.ui_gate is not None:
            await self.ui_gate.wait()
        suffix = "".join(f'table{i} = DataTable({json.dumps(item["data_ref"])})\n' for i, item in enumerate(datasets))
        suffix += "followup = Followup($question)\n"
        if on_content_delta:
            await on_content_delta(suffix)
        return LLMResponse(content=prefix + suffix, tool_calls=[ToolCallRequest(id="forged", name="lookup", arguments={})] if self.ui_invalid_tool else [])

    def get_default_model(self):
        return "test"

    async def chat(self, messages, **kwargs):
        self.agent_calls += 1
        index = max(i for i, row in enumerate(messages) if row["role"] == "user")
        question = str(messages[index]["content"])
        if "Find substantive planning content" in question:
            results = [row for row in messages[index + 1:] if row["role"] == "tool"]
            if not results:
                calls = [("search_sessions", {"query": "planning"})]
            elif len(results) == 1:
                calls = [("read_session", {"session_key": key}) for key in
                         ["websocket:saved-planning", "websocket:failed-lookup"]]
            elif len(results) == 3:
                calls = [("search_sessions", {"query": "planning", "session_keys": ["websocket:saved-planning"]})]
            else:
                return LLMResponse(content="One substantive planning conversation is ready.", tool_calls=[])
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(id=uuid4().hex, name=name, arguments=args)
                                                        for name, args in calls])
        if "Find saved planning conversations" in question:
            if not any(row["role"] == "tool" for row in messages[index + 1:]):
                return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                    id=uuid4().hex, name="search_sessions", arguments={"query": "planning"},
                )])
            return LLMResponse(content="Saved planning conversations are ready.", tool_calls=[])
        if "Explain variables" in question:
            return LLMResponse(content="A variable stores a value.", tool_calls=[])
        if "Help me plan" in question:
            return LLMResponse(content="Please provide a name and priority.", tool_calls=[])
        if "下一步" in question:
            return LLMResponse(content="先查看概览还是详细记录？", tool_calls=[])
        if not any(row["role"] == "tool" for row in messages[index + 1:]):
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(id=uuid4().hex, name="lookup", arguments={})])
        content = str(messages[-1]["content"])
        try:
            payload = json.loads(content)
            if isinstance(payload, dict) and isinstance(payload.get("summary"), str):
                content = payload["summary"]
        except ValueError:
            pass
        return LLMResponse(content=content, tool_calls=[])


class Connection:
    remote_address = None

    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))


@pytest.fixture(params=[False, True], ids=["separate", "shared"])
async def gateway(tmp_path, request):
    bus = MessageBus()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sessions = SessionManager(workspace, sessions_root=tmp_path / "sessions")
    config = WebSocketConfig.model_validate({"openui_enabled": True, "openui": {"generation": "model"}})
    services = build_gateway_services(
        config=config, bus=bus, session_manager=sessions, static_dist_path=None,
        workspace_path=workspace, default_restrict_to_workspace=True,
        runtime_model_name=None, runtime_surface="browser", runtime_capabilities_overrides=None, unified_session=request.param,
        config_path=tmp_path / "config.json",
    )
    channel = WebSocketChannel(config, bus, gateway=services)
    connection = Connection()
    channel._webui_connections.add(connection)
    channel._attach(connection, "chat")
    collector = OpenUICollector(bus, enabled=True, adapters=config.openui.tables)
    loop = AgentLoop(bus=bus, provider=Provider(provider_name="offline-p0"), workspace=workspace, session_manager=sessions, max_iterations=5, unified_session=request.param, hook_factories=[collector.hook])
    tool = Lookup()
    loop.tools.register(tool)
    disconnect = WebuiTurnCoordinator(bus, sessions, schedule_background=asyncio.ensure_future).subscribe()
    value = SimpleNamespace(bus=bus, sessions=sessions, config=config, services=services,
                            channel=channel, connection=connection, loop=loop, tool=tool, collector=collector)
    try:
        yield value
    finally:
        disconnect()
        await channel._cleanup_connection(connection)
        await channel._commands.close()
        services.temporary_chats.close()
        clear_websocket_turns("chat")
        await loop.aclose()


async def dispatch(gateway, envelope, connection=None):
    connection = connection or gateway.connection
    await gateway.channel._dispatch_envelope(connection, "browser", envelope)
    await asyncio.sleep(0)  # Drain the channel's actual ordered connection writer.


async def rpc(gateway, action, payload, connection=None):
    connection = connection or gateway.connection
    request_id = f"rpc-{len(connection.sent)}"
    await dispatch(gateway, {"type": "webui_request", "request_id": request_id,
                             "action": action, "payload": payload}, connection)
    for _ in range(1000):
        for row in reversed(connection.sent):
            if row.get("event") == "webui_response" and row.get("request_id") == request_id:
                return row
        await asyncio.sleep(0.001)
    raise AssertionError("Gateway did not return an RPC response")


async def execute(gateway, *, wait_ui=True):
    message = await asyncio.wait_for(gateway.bus.consume_inbound(), 2)
    await gateway.loop._enqueue_session_message(message)
    tasks = gateway.loop._active_tasks[gateway.loop._effective_session_key(message)]
    await asyncio.gather(*tuple(tasks))
    while gateway.bus.outbound_size:
        await gateway.channel.send(await gateway.bus.consume_outbound())
    if wait_ui:
        await gateway.services.openui.jobs.drain()
    await asyncio.sleep(0)
    return message


async def first_card(gateway, *, mode="openui", question="Look up the result"):
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": []})
    assert result["ok"]
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "turn-1",
                             "content": question, "webui": True, "ui_mode": mode})
    message = await execute(gateway)
    assert message.metadata["_openui_mode"] == mode
    events = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"]
    assert events, gateway.connection.sent
    assert events[-1]["status"] == "complete"
    return events[-1]


async def test_card_scope_survives_native_history_and_title_update(gateway):
    from nanobot.session.display_history import HistoryFact, HistoryKind

    block = await first_card(gateway)
    state = gateway.sessions.state
    await state.append_history("websocket:chat", [HistoryFact(
        kind=HistoryKind.COMPLETION, content={}, turn_id=block["turn_id"],
    )], expected_generation=block["session_generation"])
    await state.update_metadata("websocket:chat", {"title": "Updated after completion"})

    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [block["turn_id"]]})
    assert restored["result"]["session_generation"] == block["session_generation"]
    assert restored["result"]["blocks"][0]["block_id"] == block["block_id"]
    saved = await rpc(gateway, "openui.form", {
        **{key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")},
        "expected_state_version": block["state_version"],
        "form": {"form_id": "form-0", "title": "Fault details",
                 "fields": [{"label": "Location", "persist": True}], "values": ["Test road"]},
    })
    assert saved["ok"]
    assert saved["result"]["snapshot"]["state"]["$forms"]["form-0"]["values"] == ["Test road"]
    assert gateway.tool.calls == 1


async def test_confirmed_title_change_replays_receipt_without_agent_turn(gateway, tmp_path, monkeypatch):
    from nanobot.webui.sidebar_state import read_webui_sidebar_state

    monkeypatch.setattr("nanobot.webui.sidebar_state.webui_sidebar_state_path", lambda: tmp_path / "sidebar.json")
    block = await first_card(gateway)
    payload = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    payload["form_id"] = "form-0"
    prepared = await rpc(gateway, "openui.rename", {**payload, "operation": "prepare", "title": "Project plan"})
    assert prepared["ok"]
    entry = prepared["result"]["snapshot"]["state"]["$renames"]["form-0"]
    assert entry["status"] == "prepared"
    assert "websocket:chat" not in read_webui_sidebar_state()["title_overrides"]
    confirm = {**payload, "operation": "confirm", "operation_id": entry["operation_id"]}
    result = await rpc(gateway, "openui.rename", confirm)
    assert result["ok"]
    assert result["result"]["snapshot"]["state"]["$renames"]["form-0"]["status"] == "applied"
    saved = read_webui_sidebar_state()
    assert saved["title_overrides"]["websocket:chat"] == "Project plan"
    assert any(event["event"] == "sidebar_state_updated" and event["state"] == saved for event in gateway.connection.sent)
    replay = await rpc(gateway, "openui.rename", confirm)
    status = await rpc(gateway, "openui.rename", {**confirm, "operation": "status"})
    assert replay["result"] == result["result"] == status["result"]
    assert read_webui_sidebar_state() == saved
    assert gateway.bus.inbound_size == 0 and gateway.tool.calls == 1
    context = await gateway.services.openui.title_context("chat")
    assert '"current_title": "Project plan"' in context and '"status": "applied"' in context
    assert entry["operation_id"] not in context


async def test_title_operation_rejects_foreign_connection_params_and_retired_generation(gateway, tmp_path, monkeypatch):
    monkeypatch.setattr("nanobot.webui.sidebar_state.webui_sidebar_state_path", lambda: tmp_path / "sidebar.json")
    block = await first_card(gateway)
    payload = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    payload.update(form_id="form-0", operation="prepare", title="Plan")
    foreign = Connection()
    gateway.channel._webui_connections.add(foreign)
    for changed in [{"session_key": "websocket:other"}, {"title": " "}, {"title": "x" * 161}, {"revision": 2}]:
        rejected = await rpc(gateway, "openui.rename", {**payload, **changed})
        assert not rejected["ok"]
    assert not (await rpc(gateway, "openui.rename", payload, foreign))["ok"]
    prepared = await rpc(gateway, "openui.rename", payload)
    entry = prepared["result"]["snapshot"]["state"]["$renames"]["form-0"]
    await gateway.sessions.state.delete("websocket:chat")
    rejected = await rpc(gateway, "openui.rename", {
        **{key: value for key, value in payload.items() if key != "title"},
        "operation": "confirm", "operation_id": entry["operation_id"],
    })
    assert not rejected["ok"]


async def test_native_two_turn_card_action_and_refresh(gateway):
    block = await first_card(gateway)
    assert gateway.tool.calls == 1
    assert block["fallback_text"] == "Lookup result 1"
    assert block["anchor_seq"] is not None
    result = await rpc(gateway, "openui.state", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": block["block_id"],
        "revision": 1, "expected_state_version": 0, "question": "Look up again",
    })
    assert result["ok"]
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    assert next(item for item in restored["result"]["blocks"] if item["block_id"] == block["block_id"])["state"] == {"$question": "Look up again"}
    envelope = {"type": "message", "chat_id": "chat", "turn_id": "action-1", "webui": True,
                "ui_mode": "openui", "content": "Look up again", "ui_action": {
                    "session_generation": block["session_generation"], "block_id": block["block_id"],
                    "revision": 1, "request_id": "action-1", "action_id": "conversation.followup",
                }}
    await dispatch(gateway, envelope)
    message = await execute(gateway)
    assert message.content == "Look up again"
    assert message.metadata["_runtime_context_blocks"][0].source == "openui_followup"
    assert gateway.tool.calls == 2
    # Replace the router and UI runtime, retaining only the actual databases.
    from dataclasses import replace

    from nanobot.webui.inbound_commands import WebUICommandRouter
    from nanobot.webui.openui_runtime import OpenUIRuntime
    await gateway.channel._commands.close()
    services = replace(gateway.services, openui=OpenUIRuntime(gateway.sessions, gateway.bus))
    gateway.channel._commands = WebUICommandRouter(gateway.channel, services)
    gateway.channel._webui_connections.add(gateway.connection)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    await dispatch(gateway, envelope)
    assert gateway.bus.inbound_size == 0
    assert gateway.connection.sent[-1]["event"] == "message_accepted"
    await dispatch(gateway, {**envelope, "content": "Changed payload"})
    assert gateway.connection.sent[-1]["detail"] == "IDEMPOTENCY_CONFLICT"
    assert gateway.tool.calls == 2


async def test_form_drafts_submit_receipts_and_duplicate_restore_through_gateway(gateway):
    block = await first_card(gateway)
    payload = {"chat_id": "chat", "session_generation": block["session_generation"],
               "block_id": block["block_id"], "revision": 1, "expected_state_version": 0,
               "form": {"form_id": "form-0", "title": "Project", "fields": [
                   {"label": "Name", "persist": True}, {"label": "Priority", "options": ["Normal", "High"], "persist": True},
               ], "values": ["Nanobot", "High"]}}
    saved = await rpc(gateway, "openui.form", payload)
    assert saved["ok"]
    other = await rpc(gateway, "openui.form", {**payload, "chat_id": "other"})
    assert not other["ok"]
    prepared = await rpc(gateway, "openui.form", {**payload, "expected_state_version": 1,
                                                "form": {**payload["form"], "submit": True}})
    assert prepared["ok"]
    entry = prepared["result"]["snapshot"]["state"]["$forms"]["form-0"]
    envelope = {"type": "message", "chat_id": "chat", "turn_id": entry["request_id"], "webui": True,
                "content": "Project\nName: Nanobot\nPriority: High", "ui_action": {
                    "session_generation": block["session_generation"], "block_id": block["block_id"],
                    "revision": 1, "request_id": entry["request_id"], "action_id": "conversation.followup", "form_id": "form-0",
                }}
    await dispatch(gateway, envelope)
    assert gateway.bus.inbound_size == 1
    await execute(gateway)
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    form_state = restored["result"]["blocks"][0]["state"]["$forms"]["form-0"]
    assert form_state["status"] == "submitted"
    assert form_state["values"] == ["Nanobot", "High"]
    await dispatch(gateway, envelope)
    assert gateway.bus.inbound_size == 0
    assert gateway.connection.sent[-1]["event"] == "message_accepted"


async def test_whole_questionnaire_admission_uses_prepared_digest_and_form_message_limit(gateway):
    block = await first_card(gateway)
    fields = [{"label": f"Question {index}"} for index in range(6)]
    content = "Survey\n" + "\n".join(f"Question {index}: " + "a" * 400 for index in range(6))
    prepared = await rpc(gateway, "openui.form", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": block["block_id"],
        "revision": 1, "expected_state_version": 0, "form": {"form_id": "form-0", "title": "Survey",
            "fields": fields, "values": ["a" * 400] * 6, "presentation": "questionnaire", "submit": True},
    })
    assert prepared["ok"]
    entry = prepared["result"]["snapshot"]["state"]["$forms"]["form-0"]
    action = {"session_generation": block["session_generation"], "block_id": block["block_id"],
              "revision": 1, "request_id": entry["request_id"], "action_id": "conversation.followup"}
    envelope = {"type": "message", "chat_id": "chat", "turn_id": entry["request_id"],
                "webui": True, "content": content, "ui_action": action}
    await dispatch(gateway, envelope)
    assert gateway.bus.inbound_size == 0
    await dispatch(gateway, {**envelope, "content": content + "changed", "ui_action": {**action, "form_id": "form-0"}})
    assert gateway.bus.inbound_size == 0
    await dispatch(gateway, {**envelope, "ui_action": {**action, "form_id": "form-0"}})
    assert gateway.bus.inbound_size == 1
    assert gateway.connection.sent[-1]["event"] == "message_accepted"
    await execute(gateway)


async def test_form_context_survives_recap_restart_revision_and_ui_only_retry(gateway, monkeypatch):
    from dataclasses import replace

    from nanobot.llm_usage.context import current_llm_usage_source
    from nanobot.openui.forms import ConversationForm
    from nanobot.webui.inbound_commands import WebUICommandRouter
    from nanobot.webui.openui_runtime import OpenUIRuntime

    block = await first_card(gateway)
    form = {"form_id": "form-0", "title": "Project", "presentation": "questionnaire", "fields": [
        {"label": "Code", "persist": True},
        {"label": "Scope", "type": "checkbox", "options": ["UI", "API", "Other"], "persist": True},
        {"label": "Other detail", "when": {"field": 1, "value": "Other"}, "persist": True},
        {"label": "Private detail", "required": False},
    ], "values": ["ORIGINAL", ["UI", "Other"], "Keyboard", "PRIVATE-ANSWER"], "submit": True}
    original = await rpc(gateway, "openui.form", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": block["block_id"],
        "revision": 1, "expected_state_version": 0, "form": form,
    })
    request_id = original["result"]["snapshot"]["state"]["$forms"]["form-0"]["request_id"]
    agent_contexts = []

    async def answer(messages, **kwargs):
        if current_llm_usage_source() == "user":
            agent_contexts.append(messages[-1]["content"])
        # No questionnaire wording or routing keywords: the admitted action owns the intent signal.
        return LLMResponse(content="Current information is ready.", tool_calls=[])

    monkeypatch.setattr(gateway.loop.provider, "chat", answer)

    async def act(source, content, request_id, form_id=None):
        await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": request_id,
                                 "content": content, "webui": True, "ui_mode": "auto", "ui_action": {
            "session_generation": source["session_generation"], "block_id": source["block_id"], "revision": 1,
            "request_id": request_id, "action_id": "conversation.followup", "form_id": form_id,
        }})
        await execute(gateway)
        return (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [request_id]}))["result"]["blocks"][0]

    recap = await act(block, ConversationForm.model_validate(form).content(), request_id, "form-0")
    data = json.loads(gateway.loop.provider.ui_requests[-1][0][-1]["content"])
    assert data["conversation_followup"]["form"]["values"] == ["ORIGINAL", ["UI", "Other"], "Keyboard", ""]
    assert '"when":{"field":1,"value":"Other"}' in agent_contexts[-1]
    # Reopen the actual sidecar to ensure no in-memory link is required by a later click.
    options = gateway.services.openui.options
    await gateway.channel._commands.close()
    gateway.services = replace(gateway.services, openui=OpenUIRuntime(gateway.sessions, gateway.bus, options=options))
    gateway.channel._commands = WebUICommandRouter(gateway.channel, gateway.services)
    gateway.channel._webui_connections.add(gateway.connection)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [request_id]})
    revision = await act(recap, "Adjust these details", "revision")
    assert json.loads(gateway.loop.provider.ui_requests[-1][0][-1]["content"])["conversation_followup"] == data["conversation_followup"]
    revision_form = {**form, "values": ["REVISED", ["API"], "", "NEW-PRIVATE"]}
    prepared = await rpc(gateway, "openui.form", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": revision["block_id"],
        "revision": 1, "expected_state_version": 0, "form": revision_form,
    })
    request2 = prepared["result"]["snapshot"]["state"]["$forms"]["form-0"]["request_id"]
    revised_recap = await act(revision, ConversationForm.model_validate(revision_form).content(), request2, "form-0")
    latest = json.loads(gateway.loop.provider.ui_requests[-1][0][-1]["content"])["conversation_followup"]
    assert latest["form"]["values"] == ["REVISED", ["API"], "", ""]
    assert "PRIVATE" not in json.dumps(latest)
    before_agent, before_tools = len(agent_contexts), gateway.tool.calls
    retry = await rpc(gateway, "openui.retry", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": revised_recap["block_id"], "revision": 1,
    })
    assert retry["ok"]
    await gateway.services.openui.jobs.drain()
    assert json.loads(gateway.loop.provider.ui_requests[-1][0][-1]["content"])["conversation_followup"] == latest
    assert (len(agent_contexts), gateway.tool.calls) == (before_agent, before_tools)
    original_restored = (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]}))["result"]["blocks"][0]
    assert original_restored["state"]["$forms"]["form-0"]["values"][0] == "ORIGINAL"


async def test_rejects_foreign_session_deleted_generation_and_unknown_admission(gateway):
    block = await first_card(gateway)
    request = {"type": "message", "chat_id": "chat", "turn_id": "action-unknown", "webui": True,
               "content": "Lookup again", "ui_action": {
                   "session_generation": block["session_generation"], "block_id": block["block_id"],
                   "revision": 1, "request_id": "action-unknown", "action_id": "conversation.followup",
               }}
    runtime = gateway.services.openui
    await runtime.admit_action("chat", "action-unknown", request["content"], request["ui_action"])
    await dispatch(gateway, request)
    assert gateway.connection.sent[-1]["detail"] == "RESULT_UNKNOWN"
    assert gateway.bus.inbound_size == 0
    await gateway.sessions.state.reset("websocket:chat")
    await dispatch(gateway, request)
    assert gateway.connection.sent[-1]["detail"] == "STALE_GENERATION"
    assert gateway.bus.inbound_size == 0
    foreign = await rpc(gateway, "openui.subscribe", {"chat_id": "other", "turn_ids": ["turn-1"]})
    assert not foreign["ok"]


@pytest.mark.parametrize("operation", ["sdk-clear", "sdk-delete", "command-new"])
async def test_retired_session_cleans_drafts_actions_and_rejects_old_requests(gateway, operation, monkeypatch):
    from unittest.mock import AsyncMock

    from nanobot.openui.snapshots import UiConflictError, UiSnapshotStore
    from nanobot.sdk.clients import SessionClient

    block = await first_card(gateway)
    runtime = gateway.services.openui
    scope = await runtime.scope("chat")
    payload = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    draft = {**payload, "expected_state_version": 0, "form": {
        "form_id": "form-0", "title": "Project", "fields": [{"label": "Name", "persist": True}],
        "values": ["Retired draft"],
    }}
    assert (await rpc(gateway, "openui.form", draft))["ok"]
    action = {"session_generation": scope.generation, "block_id": block["block_id"], "revision": 1,
              "request_id": "retired-action", "action_id": "conversation.followup"}
    await runtime.admit_action("chat", "retired-action", "Old follow-up", action)

    gateway.channel._attach(gateway.connection, "other")
    await rpc(gateway, "openui.subscribe", {"chat_id": "other"})
    await dispatch(gateway, {"type": "message", "chat_id": "other", "turn_id": "other-turn",
                             "webui": True, "ui_mode": "openui", "content": "Lookup"})
    await execute(gateway)
    other = (await rpc(gateway, "openui.subscribe", {"chat_id": "other", "turn_ids": ["other-turn"]}))["result"]
    before = (gateway.loop.provider.agent_calls, gateway.loop.provider.ui_calls, gateway.tool.calls)
    if operation == "command-new":
        monkeypatch.setattr(gateway.loop.consolidator, "archive_session", AsyncMock())
        await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "reset-command",
                                 "webui": True, "content": "/new"})
        await execute(gateway)
    elif operation == "sdk-clear":
        await SessionClient(gateway.loop).clear("websocket:chat")
    else:
        assert await SessionClient(gateway.loop).delete("websocket:chat")

    assert (gateway.loop.provider.agent_calls, gateway.loop.provider.ui_calls, gateway.tool.calls) == before
    assert any(row.get("event") == "session_updated" and row.get("chat_id") == "chat"
               and row.get("scope") == "thread" for row in gateway.connection.sent)
    restarted = UiSnapshotStore(runtime.store.path)
    with restarted.transaction() as db:
        for table in ("ui_snapshots", "ui_actions"):
            assert db.execute(f"SELECT count(*) FROM {table} WHERE session_key=? AND generation=?",
                              (scope.session_key, scope.generation)).fetchone()[0] == 0
    with pytest.raises(KeyError):
        restarted.read(scope, block["block_id"])
    with pytest.raises(UiConflictError, match="STALE_GENERATION"):
        runtime.actions.reserve(scope, request_id="late-reservation", block_id=block["block_id"],
                                revision=1, content="Old follow-up")
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    assert restored["result"]["blocks"] == []
    for name, params in [("openui.form", draft), ("openui.retry", payload)]:
        rejected = await rpc(gateway, name, params)
        assert not rejected["ok"] and rejected["error"]["message"] == "STALE_GENERATION"
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": action["request_id"],
                             "webui": True, "content": "Old follow-up", "ui_action": action})
    assert gateway.connection.sent[-1]["detail"] == "STALE_GENERATION" and gateway.bus.inbound_size == 0
    assert (await rpc(gateway, "openui.subscribe", {"chat_id": "other", "turn_ids": ["other-turn"]}))["result"] == other
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "fresh-turn",
                             "webui": True, "ui_mode": "openui", "content": "Lookup"})
    await execute(gateway)
    fresh = (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["fresh-turn"]}))["result"]
    assert len(fresh["blocks"]) == 1 and fresh["blocks"][0]["status"] == "complete"
    assert fresh["session_generation"] != scope.generation and fresh["blocks"][0]["state"] == {}
    await runtime.retire_generation(scope.session_key, scope.generation)
    assert (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["fresh-turn"]}))["result"] == fresh


async def test_reset_cancels_inflight_view_without_reviving_it_or_replaying_tools(gateway):
    provider = gateway.loop.provider
    provider.ui_gate = asyncio.Event()
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "streaming-reset",
                             "webui": True, "ui_mode": "openui", "content": "Lookup"})
    await execute(gateway, wait_ui=False)
    await asyncio.wait_for(provider.ui_started.wait(), 2)
    runtime = gateway.services.openui
    scope = await runtime.scope("chat")
    before = (provider.agent_calls, provider.ui_calls, gateway.tool.calls)
    await asyncio.wait_for(gateway.sessions.state.reset("websocket:chat"), 2)
    provider.ui_gate.set()
    await runtime.jobs.drain()
    assert runtime.store.for_turns(scope, ["streaming-reset"]) == []
    assert not any(key[:3] == runtime.store.key(scope) for key in runtime._runtimes)
    assert (provider.agent_calls, provider.ui_calls, gateway.tool.calls) == before


@pytest.mark.parametrize("operation", ["reset", "delete"])
async def test_temporary_session_retirement_does_not_persist_ui_data(gateway, operation):
    session = await gateway.sessions.state.register_transient("websocket:private")
    await getattr(gateway.sessions.state, operation)(session.key)
    with gateway.services.openui.store.transaction() as db:
        for table in ("ui_snapshots", "ui_actions", "ui_tombstones"):
            assert db.execute(f"SELECT count(*) FROM {table} WHERE session_key=?",
                              (session.key,)).fetchone()[0] == 0


async def test_untrusted_client_and_disabled_mode_preserve_native_chat(gateway):
    connection = Connection()
    gateway.channel._attach(connection, "chat")
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat"}, connection)
    assert result["error"]["status"] == 403
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "plain",
                             "content": "Lookup", "webui": True})
    await execute(gateway)
    assert gateway.tool.calls == 1
    assert not any(row["event"] == "openui.snapshot" for row in gateway.connection.sent)
    await gateway.channel._cleanup_connection(connection)


@pytest.mark.parametrize("mode,generation", [("auto", "model"), ("markdown", "model"), ("openui", "preview")])
async def test_in_chat_data_capability_reaches_only_negotiated_model_ui_turns(gateway, monkeypatch, mode, generation):
    provider = gateway.loop.provider
    messages = []
    original = provider.chat

    async def record_chat(**kwargs):
        messages.append(kwargs["messages"])
        return await original(**kwargs)

    monkeypatch.setattr(provider, "chat", record_chat)
    gateway.services.openui.options.generation = generation
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "data-view-context", "webui": True,
                             "content": "Explain variables", "ui_mode": mode})
    await execute(gateway)
    context = json.dumps(messages[0])
    assert ("filterable/sortable tables" in context) is (mode == "auto" and generation == "model")
    assert provider.agent_calls == 1 and gateway.tool.calls == 0


async def test_real_authenticated_websocket_roundtrip(gateway, unused_tcp_port):
    import websockets

    gateway.config.port = unused_tcp_port
    server = asyncio.create_task(gateway.channel.start())
    token = gateway.services.tokens.issue_token(300, audience="webui")
    try:
        for _ in range(100):
            if gateway.channel._server is not None:
                break
            await asyncio.sleep(0.01)
        async with websockets.connect(f"ws://127.0.0.1:{unused_tcp_port}/?client_id=browser&token={token}") as socket:
            assert json.loads(await socket.recv())["openui"]["protocol"] == 1

            async def receive(event):
                while True:
                    row = json.loads(await asyncio.wait_for(socket.recv(), 5))
                    if row["event"] == event:
                        return row

            await socket.send(json.dumps({"type": "attach", "chat_id": "chat"}))
            await receive("attached")
            await socket.send(json.dumps({"type": "webui_request", "request_id": "subscribe",
                                          "action": "openui.subscribe", "payload": {"chat_id": "chat"}}))
            assert (await receive("webui_response"))["ok"]
            await socket.send(json.dumps({"type": "message", "chat_id": "chat", "turn_id": "network-turn",
                                          "content": "Lookup", "webui": True, "ui_mode": "openui"}))
            await execute(gateway)
            block = (await receive("openui.snapshot"))["snapshot"]
            while block["status"] != "complete":
                block = (await receive("openui.snapshot"))["snapshot"]
            assert block["fallback_text"] == "Lookup result 1"
            assert gateway.tool.calls == 1
            await socket.send(json.dumps({"type": "message", "chat_id": "chat", "turn_id": "network-action",
                "webui": True, "content": "Lookup again", "ui_action": {
                    "session_generation": block["session_generation"], "block_id": block["block_id"],
                    "revision": 1, "request_id": "network-action", "action_id": "conversation.followup",
                }}))
            await execute(gateway)
            assert gateway.tool.calls == 2
    finally:
        await gateway.channel.stop()
        await server


async def test_native_delete_retires_ui_and_cannot_resurrect_old_cards(gateway):
    block = await first_card(gateway)
    runtime = gateway.services.openui
    scope = await runtime.scope("chat")
    await runtime.admit_action("chat", "retiring", "Lookup again", {
        "request_id": "retiring", "action_id": "conversation.followup",
        "session_generation": block["session_generation"], "block_id": block["block_id"], "revision": 1,
    })
    response = await rpc(gateway, "session.delete", {"key": "websocket:chat"})
    assert response["ok"] and response["result"]["deleted"]
    with pytest.raises(KeyError):
        runtime.store.read(scope, block["block_id"])
    with runtime.store.transaction() as db:
        assert db.execute("SELECT count(*) FROM ui_actions").fetchone()[0] == 0
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "new-generation",
                             "content": "Lookup new", "webui": True, "ui_mode": "openui"})
    await execute(gateway)
    current = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1", "new-generation"]})
    assert current["result"]["session_generation"] != block["session_generation"]
    assert [item["turn_id"] for item in current["result"]["blocks"]] == ["new-generation"]


class TaskLookup(Lookup):
    async def execute(self, **kwargs):
        self.calls += 1
        return json.dumps({"summary": f"Lookup result {self.calls}", "records": [
            {"id": "task_08", "name": "Task 08", "energy": 5412.5, "status": "ready", "secret": "PRIVATE-FIELD"},
            {"id": "task_09", "name": "Task 09", "energy": 0, "status": "pending", "secret": "PRIVATE-FIELD"},
        ]})


def enable_model_tables(gateway):
    from nanobot.openui.data import TableAdapterConfig

    gateway.services.openui.options.generation = "model"
    gateway.collector.adapters["lookup"] = TableAdapterConfig(
        title="Captured tasks", columns={"name": "Task", "energy": "Energy", "status": "Status"},
    )
    gateway.tool = TaskLookup()
    gateway.loop.tools.register(gateway.tool)
    return gateway.loop.provider


@pytest.mark.parametrize("with_tables", [False, True])
async def test_preview_only_adds_captured_data_to_the_native_answer(gateway, with_tables):
    provider = enable_model_tables(gateway) if with_tables else gateway.loop.provider
    gateway.services.openui.options.generation = "preview"
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "preview", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    assert gateway.tool.calls == 1 and provider.ui_calls == 0
    assert any(row.get("text") == "Lookup result 1" for row in gateway.connection.sent)
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["preview"]})
    blocks = result["result"]["blocks"]
    if with_tables:
        assert len(blocks) == 1 and blocks[0]["status"] == "complete"
        assert blocks[0]["tables"]
        assert "DataTable(" in blocks[0]["source"]
        assert "Lookup result 1" not in blocks[0]["source"] and "Followup(" not in blocks[0]["source"]
    else:
        assert blocks == []


async def test_preview_keeps_an_empty_query_as_a_native_answer(gateway, monkeypatch):
    provider = enable_model_tables(gateway)
    gateway.services.openui.options.generation = "preview"

    async def empty_lookup(**kwargs):
        return json.dumps({"summary": "No matching tasks.", "records": []})

    monkeypatch.setattr(gateway.tool, "execute", empty_lookup)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "empty-preview", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    assert provider.ui_calls == 0
    assert any(row.get("text") == "No matching tasks." for row in gateway.connection.sent)
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["empty-preview"]})
    assert result["result"]["blocks"] == []


@pytest.mark.parametrize("mode", ["openui", "auto"])
async def test_model_table_values_and_record_action_use_authorized_snapshot(gateway, mode):
    provider = enable_model_tables(gateway)
    block = await first_card(gateway, mode=mode)
    assert block["generation_mode"] == "model" and provider.ui_calls == 1
    payload = json.loads(provider.ui_requests[0][0][-1]["content"])
    assert payload["question"] == block["question"] == "Look up the result"
    assert payload["public_answer"] == block["fallback_text"] == "Lookup result 1"
    assert "PRIVATE-FIELD" not in json.dumps(block)
    assert "PRIVATE-FIELD" not in provider.ui_requests[0][0][-1]["content"]
    # The UI model sees descriptors, not critical cell values.
    assert "5412.5" not in json.dumps(json.loads(provider.ui_requests[0][0][-1]["content"])["datasets"])
    table = next(iter(block["tables"].values()))
    assert table["rows"][0]["values"]["energy"] == 5412.5
    assert table["rows"][1]["values"]["energy"] == 0
    request = {"chat_id": "chat", "block_id": block["block_id"], "revision": 1,
               "session_generation": block["session_generation"], "data_ref": table["data_ref"], "record_id": "task_08"}
    result = await rpc(gateway, "openui.prepare_record", request)
    assert result["ok"] and result["result"]["content"] == "Analyze Captured tasks: Task 08"
    ui_action = {key: value for key, value in request.items() if key != "chat_id"}
    ui_action.update(action_id="record.analyze", request_id="analyze-task")
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "webui": True,
                             "turn_id": "forged-summary", "content": "Analyze another record",
                             "ui_action": {**ui_action, "request_id": "forged-summary"}})
    assert gateway.connection.sent[-1]["detail"] == "INVALID_PARAMS" and gateway.bus.inbound_size == 0
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "webui": True, "ui_mode": mode,
                             "turn_id": "analyze-task", "content": result["result"]["content"], "ui_action": ui_action})
    message = await execute(gateway)
    assert message.session_generation is not None
    assert message.content == result["result"]["content"]
    context = message.metadata["_runtime_context_blocks"][0]
    assert context.source == "openui_record"
    assert '"energy":5412.5' in context.content and '"record_id":"task_08"' in context.content
    assert "PRIVATE-FIELD" not in context.content
    assert gateway.tool.calls == 2 and provider.ui_calls == 2
    forged = await rpc(gateway, "openui.prepare_record", {**request, "record_id": "not-in-snapshot"})
    assert not forged["ok"] and gateway.tool.calls == 2


async def test_sql_snapshot_row_analysis_runs_a_second_native_tool_turn_in_the_same_session(gateway, monkeypatch):
    from nanobot.openui.data import TableAdapterConfig

    provider = enable_model_tables(gateway)
    gateway.collector.adapters["lookup"] = TableAdapterConfig(
        title="Readonly query", result_format="sql_readonly", id_field=None,
        columns={"type": "Type", "count": "Count", "device": "Device"},
    )

    async def query(**kwargs):
        gateway.tool.calls += 1
        rows = [{"type": "A", "count": 8}] if gateway.tool.calls == 1 else [{"device": "A1"}]
        return json.dumps({"ok": True, "rows": rows, "meta": {"truncated": False}, "connection": "PRIVATE-CONNECTION"})

    monkeypatch.setattr(gateway.tool, "execute", query)
    block = await first_card(gateway, mode="auto")
    table = next(iter(block["tables"].values()))
    assert table["columns"] == {"type": "Type", "count": "Count"}
    assert table["rows"] == [{"id": "row_1", "values": {"type": "A", "count": 8}}]
    assert table["session_query"] is None
    request = {"chat_id": "chat", "block_id": block["block_id"], "revision": block["revision"],
               "session_generation": block["session_generation"], "data_ref": table["data_ref"], "record_id": "row_1"}
    prepared = await rpc(gateway, "openui.prepare_record", request)
    assert prepared["ok"]
    action = {key: value for key, value in request.items() if key != "chat_id"}
    action.update(action_id="record.analyze", request_id="sql-row-analysis")
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "webui": True, "ui_mode": "auto",
                             "turn_id": "sql-row-analysis", "content": prepared["result"]["content"], "ui_action": action})
    message = await execute(gateway)
    assert message.chat_id == "chat" and gateway.tool.calls == 2 and provider.ui_calls == 2
    assert '"count":8' in message.metadata["_runtime_context_blocks"][0].content
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["sql-row-analysis"]})
    followup = restored["result"]["blocks"][0]
    assert next(iter(followup["tables"].values()))["rows"][0]["values"] == {"device": "A1"}
    assert "PRIVATE-CONNECTION" not in json.dumps(block["tables"]) + json.dumps(followup["tables"])


async def test_auto_skips_plain_answers_but_preserves_explicit_mode_and_followup_intent(gateway):
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    cases = [
        ("auto-plain", "auto", "Explain variables", 0),
        ("forced", "openui", "Explain variables", 1),
        ("disabled", "markdown", "Help me plan", 1),
        ("forced-text-only", "openui", "Explain variables, text only", 1),
        ("auto-ask", "auto", "Help me plan", 2),
        ("auto-request", "auto", "Explain variables. Use clickable buttons for follow-up choices.", 3),
        ("natural-choice", "auto", "下一步", 4),
        ("edit-form", "auto", "修改上面的问卷。Explain variables", 5),
        ("quoted-request", "auto", "Explain variables:\n> Use clickable buttons", 5),
    ]
    for turn_id, mode, content, calls in cases:
        await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": turn_id,
                                 "webui": True, "ui_mode": mode, "content": content})
        await execute(gateway)
        assert gateway.loop.provider.ui_calls == calls
        blocks = (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [turn_id]}))["result"]["blocks"]
        assert len(blocks) == (0 if turn_id in {"auto-plain", "disabled", "forced-text-only", "quoted-request"} else 1)
    assert gateway.tool.calls == 0


async def test_selected_search_results_survive_refresh_without_restoring_rejected_candidates(gateway):
    from nanobot.agent.tools.sessions import ReadSessionTool, SearchSessionsTool
    from nanobot.openui.data import TableAdapterConfig

    for key, title, text in [
        ("websocket:saved-planning", "Planning decisions", "Approved read-only workflow."),
        ("websocket:failed-lookup", "Planning lookup", "No substantive discussion found."),
    ]:
        saved = await gateway.sessions.state.get(key)
        saved.metadata["title"] = title
        saved.add_message("assistant", text)
        await gateway.sessions.state.finish_turn(saved)
    adapter = TableAdapterConfig(title="Saved conversations", records_key="results", id_field="session_key",
                                 columns={"title": "Title", "updated_at": "Updated"})
    gateway.collector.adapters["search_sessions"] = adapter
    gateway.services.openui.options.tables["search_sessions"] = adapter
    gateway.loop.tools.register(SearchSessionsTool(gateway.sessions))
    gateway.loop.tools.register(ReadSessionTool(gateway.sessions))
    block = await first_card(gateway, question="Find substantive planning content")
    assert len(block["tables"]) == 1
    table = next(iter(block["tables"].values()))
    assert [row["id"] for row in table["rows"]] == ["websocket:saved-planning"]
    assert table["session_query"]["session_keys"] == ["websocket:saved-planning"]
    counts = gateway.loop.provider.agent_calls, gateway.loop.provider.ui_calls
    request = {"chat_id": "chat", "session_generation": block["session_generation"],
               "block_id": block["block_id"], "revision": block["revision"], "data_ref": table["data_ref"]}
    refreshed = await rpc(gateway, "openui.query", {**request, "operation": "refresh"})
    assert refreshed["ok"]
    updated = refreshed["result"]["snapshot"]["tables"][table["data_ref"]]
    assert [row["id"] for row in updated["rows"]] == ["websocket:saved-planning"]
    rejected = await rpc(gateway, "openui.query", {**request, "operation": "detail", "record_id": "websocket:failed-lookup"})
    assert not rejected["ok"]
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    assert restored["result"]["blocks"][0]["tables"][table["data_ref"]] == updated
    assert counts == (gateway.loop.provider.agent_calls, gateway.loop.provider.ui_calls)


async def test_readonly_queries_refresh_live_sessions_and_gate_details_without_agent(gateway, monkeypatch):
    from nanobot.agent.tools.sessions import ReadSessionTool, SearchSessionsTool
    from nanobot.openui.data import TableAdapterConfig
    from nanobot.openui.snapshots import UiSnapshotStore

    saved = await gateway.sessions.state.get("websocket:saved-planning")
    saved.metadata["title"] = "Planning notes"
    saved.add_message("user", "Visible planning detail")
    saved.add_message("system", "HIDDEN-SYSTEM")
    await gateway.sessions.state.finish_turn(saved)
    adapter = TableAdapterConfig(title="Saved conversations", records_key="results", id_field="session_key",
                                 columns={"title": "Title", "updated_at": "Updated"})
    gateway.collector.adapters["search_sessions"] = adapter
    gateway.services.openui.options.tables["search_sessions"] = adapter
    gateway.loop.tools.register(SearchSessionsTool(gateway.sessions))
    gateway.loop.tools.register(ReadSessionTool(gateway.sessions))
    provider = gateway.loop.provider
    block = await first_card(gateway, question="Find saved planning conversations")
    table = next(iter(block["tables"].values()))
    assert table["session_query"]["query"] == "planning"
    before_calls = provider.agent_calls, provider.ui_calls
    payload = {"chat_id": "chat", "session_generation": block["session_generation"],
               "block_id": block["block_id"], "revision": block["revision"], "data_ref": table["data_ref"]}
    detail = await rpc(gateway, "openui.query", {**payload, "operation": "detail", "record_id": saved.key})
    assert detail["ok"] and detail["result"]["detail"] == {
        "title": "Planning notes", "messages": [{"role": "user", "content": "Visible planning detail"}],
    }
    for changed in [{"record_id": "websocket:not-listed"}, {"data_ref": "foreign-data"},
                    {"session_generation": "foreign-generation"}, {"revision": 99}]:
        rejected = await rpc(gateway, "openui.query", {**payload, "operation": "detail", "record_id": saved.key, **changed})
        assert not rejected["ok"]
    rejected = await rpc(gateway, "openui.query", {**payload, "operation": "refresh", "query": "steal another search"})
    assert not rejected["ok"]
    foreign = Connection()
    gateway.channel._webui_connections.add(foreign)
    gateway.channel._attach(foreign, "other-chat")
    await rpc(gateway, "openui.subscribe", {"chat_id": "other-chat"}, foreign)
    rejected = await rpc(gateway, "openui.query", {**payload, "operation": "refresh"}, foreign)
    assert not rejected["ok"]
    other = await gateway.sessions.state.get("websocket:new-planning")
    other.metadata["title"] = "Planning newly saved"
    other.add_message("assistant", "New visible result")
    await gateway.sessions.state.finish_turn(other)
    refreshed = await rpc(gateway, "openui.query", {**payload, "operation": "refresh"})
    assert refreshed["ok"]
    updated = refreshed["result"]["snapshot"]
    assert updated["seq"] == block["seq"] + 1 and updated["source"] == block["source"]
    row_ids = {row["id"] for row in updated["tables"][table["data_ref"]]["rows"]}
    assert {saved.key, other.key} <= row_ids
    assert table["session_query"]["exclude_session_key"] not in row_ids
    scope = await gateway.services.openui.scope("chat")
    assert UiSnapshotStore(gateway.services.openui.store.path).read(scope, block["block_id"]).seq == updated["seq"]
    # A previously listed session may become private; membership alone cannot authorize it.
    await gateway.sessions.state.update_metadata(saved.key, {"session_type": "private-query-test"})
    hidden = await rpc(gateway, "openui.query", {**payload, "operation": "detail", "record_id": saved.key})
    assert not hidden["ok"] and hidden["error"]["message"] == "UI_QUERY_UNAVAILABLE"
    started, release = asyncio.Event(), asyncio.Event()
    original_read = ReadSessionTool.execute

    async def delayed_read(self, **kwargs):
        started.set()
        await release.wait()
        return await original_read(self, **kwargs)

    monkeypatch.setattr(ReadSessionTool, "execute", delayed_read)
    pending = asyncio.create_task(rpc(gateway, "openui.query", {**payload, "operation": "detail", "record_id": other.key}))
    await asyncio.wait_for(started.wait(), 2)
    await gateway.services.openui.retire_session("websocket:chat")
    release.set()
    retired = await asyncio.wait_for(pending, 2)
    assert not retired["ok"]
    assert (provider.agent_calls, provider.ui_calls) == before_calls
    assert gateway.bus.inbound_size == 0 and gateway.tool.calls == 0


async def test_invalid_mode_is_rejected_before_agent_admission(gateway):
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "bad-mode",
                             "webui": True, "ui_mode": "automatic", "content": "Help me plan"})
    assert gateway.bus.inbound_size == 0
    assert any(row.get("detail") == "invalid_ui_mode" for row in gateway.connection.sent)


async def test_slow_ui_does_not_block_other_turn_and_can_cancel_without_tools(gateway):
    provider = enable_model_tables(gateway)
    provider.ui_gate = asyncio.Event()
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "slow-ui", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway, wait_ui=False)
    await asyncio.wait_for(provider.ui_started.wait(), 2)
    block = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"][-1]
    assert block["status"] == "streaming" and "Task overview" in block["source"]
    gateway.channel._attach(gateway.connection, "other")
    await dispatch(gateway, {"type": "message", "chat_id": "other", "turn_id": "plain-other",
                             "webui": True, "content": "Lookup"})
    await asyncio.wait_for(execute(gateway, wait_ui=False), 2)
    assert gateway.tool.calls == 2 and provider.ui_calls == 1
    assert not provider.ui_gate.is_set()
    from nanobot.runtime_admission import RuntimeBusyError
    with pytest.raises(RuntimeBusyError):
        with gateway.bus.admission.pause_if_idle(lambda: False):
            pass
    result = await rpc(gateway, "openui.cancel", {
        "chat_id": "chat", "session_generation": block["session_generation"], "block_id": block["block_id"], "revision": 1,
    })
    assert result["ok"] and result["result"]["snapshot"]["status"] == "cancelled"
    assert gateway.tool.calls == 2 and gateway.bus.inbound_size == 0


async def test_ui_failure_retry_is_display_only_and_idempotent(gateway):
    provider = enable_model_tables(gateway)
    provider.ui_invalid_tool = True
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "failed-ui", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    block = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"][-1]
    assert block["status"] == "failed" and gateway.tool.calls == 1
    provider.ui_invalid_tool = False
    request = {"chat_id": "chat", "session_generation": block["session_generation"], "block_id": block["block_id"], "revision": 1}
    assert (await rpc(gateway, "openui.retry", request))["ok"]
    await gateway.services.openui.jobs.drain()
    assert (await rpc(gateway, "openui.retry", request))["result"]["snapshot"]["revision"] == 2
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["failed-ui"]})
    assert restored["result"]["blocks"][0]["status"] == "complete"
    assert provider.ui_calls == 2 and gateway.tool.calls == 1 and gateway.bus.inbound_size == 0
    assert [json.loads(messages[-1]["content"])["question"] for messages, _ in provider.ui_requests] == ["Lookup", "Lookup"]


async def test_interrupted_ui_stays_failed_until_display_only_retry(gateway):
    provider = enable_model_tables(gateway)
    provider.ui_stream_stalled = True
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "interrupted-ui", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    block = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"][-1]
    assert block["status"] == "failed" and block["fallback_text"] == "Lookup result 1"
    assert provider.ui_calls == 1 and gateway.tool.calls == 1
    provider.ui_stream_stalled = False
    request = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    assert (await rpc(gateway, "openui.retry", request))["ok"]
    await gateway.services.openui.jobs.drain()
    restored = (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["interrupted-ui"]}))["result"]["blocks"][0]
    assert restored["status"] == "complete" and restored["revision"] == 2
    assert restored["source"].count("root = Panel") == 1
    assert gateway.tool.calls == 1 and provider.ui_calls == 2 and gateway.bus.inbound_size == 0


async def test_ui_retry_preserves_saved_user_input(gateway):
    block = await first_card(gateway)
    request = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    saved = (await rpc(gateway, "openui.state", {**request, "expected_state_version": 0, "question": "Keep this draft"}))["result"]["snapshot"]
    result = await rpc(gateway, "openui.retry", request)
    assert not result["ok"] and result["error"]["message"] == "UI_STATE_SAVED"
    restored = (await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [block["turn_id"]]}))["result"]["blocks"][0]
    assert restored == saved and gateway.tool.calls == 1


async def test_ui_timeout_keeps_native_answer(gateway):
    provider = enable_model_tables(gateway)
    provider.ui_gate = asyncio.Event()
    gateway.services.openui.jobs.timeout = 0.05
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "timeout-ui", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    block = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"][-1]
    assert block["status"] == "failed" and block["error_code"] == "UI_TIMEOUT"
    assert block["fallback_text"] and gateway.tool.calls == 1
    assert any(row["event"] == "message" for row in gateway.connection.sent)


async def test_restart_restores_model_snapshot_without_business_or_model_replay(gateway):
    from dataclasses import replace

    from nanobot.webui.inbound_commands import WebUICommandRouter
    from nanobot.webui.openui_runtime import OpenUIRuntime

    provider = enable_model_tables(gateway)
    block = await first_card(gateway)
    await gateway.channel._commands.close()
    services = replace(gateway.services, openui=OpenUIRuntime(gateway.sessions, gateway.bus))
    gateway.channel._commands = WebUICommandRouter(gateway.channel, services)
    gateway.channel._webui_connections.add(gateway.connection)
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    assert restored["result"]["blocks"][0]["tables"] == block["tables"]
    assert restored["result"]["blocks"][0]["source"] == block["source"]
    retry = await rpc(gateway, "openui.retry", {
        "chat_id": "chat", "session_generation": block["session_generation"],
        "block_id": block["block_id"], "revision": 1,
    })
    assert not retry["ok"] and retry["error"]["message"] == "UI_MODEL_UNAVAILABLE"
    assert gateway.tool.calls == 1 and provider.ui_calls == 1


async def test_lost_complete_delivery_recovers_committed_snapshot_without_replay(gateway, monkeypatch):
    provider = enable_model_tables(gateway)
    router = gateway.channel._commands
    emit = router.emit_openui

    async def lose_complete(snapshot):
        if snapshot.status == "complete":
            raise OSError("connection lost after persistence")
        await emit(snapshot)

    monkeypatch.setattr(router, "emit_openui", lose_complete)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "lost-delivery", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    assert not any(row.get("snapshot", {}).get("status") == "complete" for row in gateway.connection.sent)
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["lost-delivery"]})
    block = restored["result"]["blocks"][0]
    assert block["status"] == "complete" and block["source"] and block["tables"]
    assert block["fallback_text"] == "Lookup result 1"
    assert gateway.tool.calls == 1 and provider.ui_calls == 1 and gateway.bus.inbound_size == 0


async def test_ui_persistence_failure_leaves_native_answer_readable(gateway, monkeypatch):
    provider = enable_model_tables(gateway)

    def unavailable(*args, **kwargs):
        raise OSError("UI storage unavailable")

    monkeypatch.setattr(gateway.services.openui.store, "create", unavailable)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat"})
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "lost-view", "webui": True,
                             "content": "Lookup", "ui_mode": "openui"})
    await execute(gateway)
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["lost-view"]})
    assert restored["result"]["blocks"] == []
    answers = await gateway.sessions.state.project_history("websocket:chat", lambda history: [
        fact.content.get("text") for fact in history.all_facts() if fact.phase == "answer"
    ])
    assert "Lookup result 1" in answers
    assert any(row.get("text") == "Lookup result 1" for row in gateway.connection.sent)
    assert gateway.tool.calls == 1 and provider.ui_calls == 0 and gateway.bus.inbound_size == 0


@pytest.mark.parametrize("entrypoint", ["subscribe", "action"])
async def test_orphan_view_is_removed_without_losing_admission_fence(gateway, entrypoint):
    import sqlite3

    from nanobot.webui.openui_runtime import UiBlockRequest

    block = await first_card(gateway)
    runtime = gateway.services.openui
    scope = await runtime.scope("chat")
    reserved = dict(request_id="lost-ack", block_id=block["block_id"], revision=1, content="Continue")
    assert runtime.actions.reserve(scope, **reserved) == "new"
    # Simulate native-history rollback after a crash, leaving the UI sidecar ahead.
    with sqlite3.connect(gateway.sessions.sessions_dir / "sessions.sqlite3") as db:
        db.execute("DELETE FROM history_entries WHERE session_key=? AND json_extract(record, '$.turn_id')=? "
                   "AND json_extract(record, '$.phase')='answer'", (scope.session_key, block["turn_id"]))
    payload = {key: block[key] for key in ("chat_id", "session_generation", "block_id", "revision")}
    if entrypoint == "action":
        with pytest.raises(ValueError, match="UI_ANCHOR_UNAVAILABLE"):
            await runtime.block(UiBlockRequest.model_validate(payload))
    restored = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [block["turn_id"]]})
    assert restored["result"]["blocks"] == []
    rejected = await rpc(gateway, "openui.state", {**payload, "expected_state_version": 0, "question": "Continue"})
    assert not rejected["ok"]
    assert runtime.actions.reserve(scope, **reserved) == "unknown"
    assert gateway.tool.calls == 1 and gateway.bus.inbound_size == 0


async def test_future_ui_schema_disables_views_and_keeps_native_chat(gateway, tmp_path):
    import sqlite3

    from nanobot.webui.inbound_commands import WebUICommandRouter

    block = await first_card(gateway)
    path = gateway.services.openui.store.path
    await gateway.channel._commands.close()
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version = 999")
        before = db.execute("SELECT snapshot FROM ui_snapshots").fetchall()
    services = build_gateway_services(
        config=gateway.config, bus=gateway.bus, session_manager=gateway.sessions, static_dist_path=None,
        workspace_path=gateway.loop.workspace, default_restrict_to_workspace=True,
        runtime_model_name=None, runtime_surface="browser", runtime_capabilities_overrides=None,
        unified_session=gateway.services.unified_session, config_path=tmp_path / "config.json",
    )
    try:
        assert services.openui is None
        gateway.channel._commands = WebUICommandRouter(gateway.channel, services)
        services.endpoint.webui_connections.add(gateway.connection)
        response = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": [block["turn_id"]]})
        assert not response["ok"] and response["error"]["message"] == "UI_DISABLED"
        await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "native-after-rollback", "webui": True,
                                 "content": "Continue normally"})
        await execute(gateway)
        assert any(row.get("text") == "Lookup result 2" for row in gateway.connection.sent)
        with sqlite3.connect(path) as db:
            assert db.execute("PRAGMA user_version").fetchone()[0] == 999
            assert db.execute("SELECT snapshot FROM ui_snapshots").fetchall() == before
    finally:
        services.temporary_chats.close()


async def test_maintenance_at_ui_handoff_preserves_native_delivery(gateway):
    from nanobot.session.display_history import HISTORY_GENERATION_METADATA_KEY

    block = await first_card(gateway)
    with gateway.bus.admission.pause_if_idle(lambda: False):
        await gateway.channel._commands.capture_openui_turn(
            "chat", {"turn_id": "waiting-turn", "outcome": "completed"},
            metadata={"_openui_mode": "openui", HISTORY_GENERATION_METADATA_KEY: block["session_generation"]},
        )
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["waiting-turn"]})
    assert result["ok"] and result["result"]["blocks"] == []
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "ordinary",
                             "content": "Continue normally", "webui": True})
    await execute(gateway)
    assert gateway.tool.calls == 2
    assert any(row.get("text") == "Lookup result 2" for row in gateway.connection.sent)


async def test_duplicate_completion_preserves_original_captured_data(gateway, monkeypatch):
    provider = enable_model_tables(gateway)
    runtime = gateway.services.openui
    schedule = runtime.schedule_turn

    def duplicate(*args, **kwargs):
        schedule(*args, **kwargs)
        schedule(*args, **kwargs)

    monkeypatch.setattr(runtime, "schedule_turn", duplicate)
    block = await first_card(gateway)
    assert block["status"] == "complete" and block["tables"]
    assert provider.ui_calls == 1 and gateway.tool.calls == 1
