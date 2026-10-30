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
    def get_default_model(self):
        return "test"

    async def chat(self, messages, **kwargs):
        index = max(i for i, row in enumerate(messages) if row["role"] == "user")
        if not any(row["role"] == "tool" for row in messages[index + 1:]):
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(id=uuid4().hex, name="lookup", arguments={})])
        return LLMResponse(content=str(messages[-1]["content"]), tool_calls=[])


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
    config = WebSocketConfig(openui_enabled=True)
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
    loop = AgentLoop(bus=bus, provider=Provider(provider_name="offline-p0"), workspace=workspace, session_manager=sessions, max_iterations=5, unified_session=request.param)
    tool = Lookup()
    loop.tools.register(tool)
    disconnect = WebuiTurnCoordinator(bus, sessions, schedule_background=asyncio.ensure_future).subscribe()
    value = SimpleNamespace(bus=bus, sessions=sessions, config=config, services=services,
                            channel=channel, connection=connection, loop=loop, tool=tool)
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


async def execute(gateway):
    message = await asyncio.wait_for(gateway.bus.consume_inbound(), 2)
    await gateway.loop._enqueue_session_message(message)
    tasks = gateway.loop._active_tasks[gateway.loop._effective_session_key(message)]
    await asyncio.gather(*tuple(tasks))
    while gateway.bus.outbound_size:
        await gateway.channel.send(await gateway.bus.consume_outbound())
    await asyncio.sleep(0)
    return message


async def first_card(gateway):
    result = await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": []})
    assert result["ok"]
    await dispatch(gateway, {"type": "message", "chat_id": "chat", "turn_id": "turn-1",
                             "content": "Look up the result", "webui": True, "ui_mode": "openui"})
    message = await execute(gateway)
    assert message.metadata["_openui_mode"] == "openui"
    events = [row["snapshot"] for row in gateway.connection.sent if row["event"] == "openui.snapshot"]
    assert events, gateway.connection.sent
    assert events[-1]["status"] == "complete"
    return events[-1]


async def test_native_two_turn_card_action_and_refresh(gateway):
    block = await first_card(gateway)
    assert gateway.tool.calls == 1
    assert "Lookup result 1" in block["source"]
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
    await execute(gateway)
    assert gateway.tool.calls == 2
    # Replace the router and UI runtime, retaining only the actual databases.
    from dataclasses import replace

    from nanobot.webui.inbound_commands import WebUICommandRouter
    from nanobot.webui.openui_runtime import OpenUIRuntime
    await gateway.channel._commands.close()
    services = replace(gateway.services, openui=OpenUIRuntime(gateway.sessions))
    gateway.channel._commands = WebUICommandRouter(gateway.channel, services)
    gateway.channel._webui_connections.add(gateway.connection)
    await rpc(gateway, "openui.subscribe", {"chat_id": "chat", "turn_ids": ["turn-1"]})
    await dispatch(gateway, envelope)
    assert gateway.bus.inbound_size == 0
    assert gateway.connection.sent[-1]["event"] == "message_accepted"
    await dispatch(gateway, {**envelope, "content": "Changed payload"})
    assert gateway.connection.sent[-1]["detail"] == "IDEMPOTENCY_CONFLICT"
    assert gateway.tool.calls == 2


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
            assert "Lookup result 1" in block["source"]
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
