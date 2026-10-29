"""P0 proof using the real AgentLoop/session store and an offline model double.

This does not claim a real-provider or browser-to-gateway end-to-end test.
"""

import json
from copy import deepcopy

from nanobot.agent.hook import AgentHook
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.bus.queue import MessageBus
from nanobot.bus.runtime_events import SessionTurnPersisted
from nanobot.openui.snapshots import UiScope, UiSnapshot, UiSnapshotStore
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest


class InspectTask(Tool):
    name = "inspect_task"
    description = "Return the fixture task, without any external I/O."
    parameters = {
        "type": "object", "properties": {"period": {"type": "string", "enum": ["7", "30"]}},
        "required": ["period"], "additionalProperties": False,
    }
    read_only = True

    async def execute(self, period, **kwargs):
        return json.dumps({"record_id": "task_08", "status": "ready", "period": period})


class TaskProvider(LLMProvider):
    def __init__(self):
        super().__init__(provider_name="offline-openui-poc")
        self.requests = []

    def get_default_model(self):
        return "offline-test"

    async def chat(self, messages, tools=None, **kwargs):
        self.requests.append(deepcopy(messages))
        user_index = max(index for index, message in enumerate(messages) if message["role"] == "user")
        if not any(message["role"] == "tool" for message in messages[user_index + 1:]):
            period = "30" if "for 30 days" in str(messages[user_index]["content"]) else "7"
            return LLMResponse(content="Checking task", tool_calls=[
                ToolCallRequest(id=f"inspect-{period}", name="inspect_task", arguments={"period": period}),
            ])
        return LLMResponse(content="Task task_08 is ready.", tool_calls=[])


class CaptureTool(AgentHook):
    def __init__(self, results, order):
        super().__init__(reraise=True)
        self.results = results
        self.order = order

    async def after_execute_tool(self, context, tool_call, tool, params, result):
        self.results.append(json.loads(str(result)))
        self.order.append("tool")

    async def after_run(self, context):
        self.order.append("after_run")


async def test_tool_hook_persistence_and_same_session_continuation_after_restart(tmp_path):
    session_key = "websocket:openui-poc"
    chat_id = "openui-poc"
    store = UiSnapshotStore(tmp_path / "ui.sqlite3")
    provider = TaskProvider()
    bus = MessageBus()
    loop = AgentLoop(bus=bus, provider=provider, workspace=tmp_path, model="offline-test")
    loop.tools.register(InspectTask())
    results, order, contexts, persisted = [], [], [], []

    def factory(context):
        contexts.append(context)
        return CaptureTool(results, order)

    async def on_persisted(event):
        # Read the committed native session at the event boundary, not a hook's
        # detached run context. This event is not a final display-delivery ack.
        session = await loop.sessions.state.read(session_key)
        assert session is not None
        assert "task_08" in json.dumps(session.messages)
        assert event.context.session_key == session_key
        assert event.turn_id
        scope = UiScope(owner="local-host", session_key=session_key, generation=session.generation)
        store.create(scope, UiSnapshot(
            chat_id=chat_id, session_generation=scope.generation,
            turn_id=event.turn_id, block_id="block-1", library_hash="nanobot-openui-poc-v1",
        ), state_keys=frozenset({"$period"}))
        store.advance(scope, "block-1", revision=1, expected_seq=0,
                      delta='root = Panel([Text("Task 08 is ready")])', status="complete")
        store.save_state(scope, "block-1", revision=1, expected_state_version=0,
                         state={"$period": "30"})
        persisted.append((scope, event.turn_id))
        order.append("persisted")

    unsubscribe = bus.subscribe(on_persisted, SessionTurnPersisted)
    try:
        result = await loop.process_direct("Show task 08", session_key=session_key,
                                           channel="websocket", chat_id=chat_id, hook_factories=[factory])
        assert result is not None and "task_08" in result.content
        assert results == [{"record_id": "task_08", "status": "ready", "period": "7"}]
        assert contexts[0].session_key == session_key
        assert contexts[0].chat_id == chat_id
        assert order == ["tool", "after_run", "persisted"]
        assert len(persisted) == 1
    finally:
        unsubscribe()
        await loop.aclose()

    scope, original_turn = persisted[0]
    restored = UiSnapshotStore(store.path).read(scope, "block-1")
    assert restored.turn_id == original_turn
    assert restored.state == {"$period": "30"}
    fresh_provider = TaskProvider()
    restarted = AgentLoop(bus=MessageBus(), provider=fresh_provider, workspace=tmp_path, model="offline-test")
    restarted.tools.register(InspectTask())
    try:
        await restarted.process_direct("Inspect task task_08 for 30 days.", session_key=session_key,
                                       channel="websocket", chat_id=chat_id)
        request = fresh_provider.requests[0]
        assert any(message["role"] == "tool" and "task_08" in str(message["content"]) for message in request)
        assert "Inspect task task_08 for 30 days." in str(request[-1]["content"])
        session = await restarted.sessions.state.read(session_key)
        assert session is not None and session.generation == scope.generation
        tool_results = [json.loads(message["content"]) for message in session.messages if message["role"] == "tool"]
        assert [result["period"] for result in tool_results] == ["7", "30"]
    finally:
        await restarted.aclose()
