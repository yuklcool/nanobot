"""Disposable browser Gateway; real credentials require an explicit live opt-in."""

import argparse
import asyncio
import json
import os
import signal
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from loguru import logger

from nanobot.agent.hook import AgentHook
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.sessions import ReadSessionTool, SearchSessionsTool
from nanobot.bus.queue import MessageBus
from nanobot.channels.manager import ChannelManager
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.config.home import set_home_path
from nanobot.config.loader import load_config, resolve_config_env_vars, save_config, set_config_path
from nanobot.config.schema import Config
from nanobot.llm_usage.context import current_llm_usage_source
from nanobot.openui.collector import OpenUICollector
from nanobot.openui.config import OpenUIOptions
from nanobot.openui.snapshots import UiSnapshot
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.providers.factory import make_provider
from nanobot.sdk.clients import SessionClient
from nanobot.session.manager import SessionManager
from nanobot.session.webui_turns import WebuiTurnCoordinator
from nanobot.utils.file_io import write_text_atomic
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.history import fact_from_record
from nanobot.webui.http_utils import http_json_response
from nanobot.webui.openui_runtime import LIBRARY_HASH

SURVEY_TITLE = "公司员工就业情况调查表"
SURVEY_DESCRIPTION = "本问卷用于了解员工今年的工作情况，结果仅作汇总分析。"
SURVEY_ANSWER = f"""# {SURVEY_TITLE}
{SURVEY_DESCRIPTION}
1. 您目前的工作状态是？在职 / 休假中 / 已离职 / 其他（请补充）
2. 与去年相比，您的工作稳定性如何？更稳定 / 差不多 / 不太稳定
3. 今年您的收入与去年相比如何？增加 / 基本持平 / 减少 / 不便透露
4. 您今年是否考虑过离职或寻找新工作？是 / 否
   如果是，主要原因（多选）：薪酬 / 压力 / 发展机会 / 其他（请补充）
5. 您对目前岗位的满意度如何？满意 / 一般 / 不满意
6. 您希望公司提供哪些支持？（多选）薪酬福利 / 培训发展 / 优化工作量 / 其他（请补充）"""
SURVEY_FIELDS = [
    {"label": "1. 您目前的工作状态是？", "type": "radio", "options": ["在职", "休假中", "已离职", "其他"]},
    {"label": "其他工作状态", "when": {"field": 0, "value": "其他"}},
    {"label": "2. 与去年相比，您的工作稳定性如何？", "type": "radio", "options": ["更稳定", "差不多", "不太稳定"]},
    {"label": "3. 今年您的收入与去年相比如何？", "type": "radio", "options": ["增加", "基本持平", "减少", "不便透露"]},
    {"label": "4. 您今年是否考虑过离职或寻找新工作？", "type": "radio", "options": ["是", "否"]},
    {"label": "主要原因（多选）", "type": "checkbox", "options": ["薪酬", "压力", "发展机会", "其他"],
     "when": {"field": 4, "value": "是"}},
    {"label": "其他离职原因", "when": {"field": 5, "value": "其他"}},
    {"label": "5. 您对目前岗位的满意度如何？", "type": "radio", "options": ["满意", "一般", "不满意"]},
    {"label": "6. 您希望公司提供哪些支持？（多选）", "type": "checkbox", "options": ["薪酬福利", "培训发展", "优化工作量", "其他"]},
    {"label": "其他支持", "when": {"field": 8, "value": "其他"}},
]
CATEGORY_OPTIONS = [f"Category {index + 1}" for index in range(8)]
CATEGORY_ANSWER = "Please choose a category and the categories to compare: " + ", ".join(CATEGORY_OPTIONS)
CATEGORY_FIELDS = [
    {"label": "Category", "type": "select", "options": CATEGORY_OPTIONS, "persist": True},
    {"label": "Compare", "type": "checkbox", "options": CATEGORY_OPTIONS, "persist": True},
]


class Lookup(Tool):
    name = "lookup"
    description = "Return a deterministic test record."
    read_only = True
    parameters = {"type": "object", "properties": {}}

    def __init__(self):
        self.calls = 0

    async def execute(self, **kwargs):
        self.calls += 1
        return json.dumps({"summary": f"Lookup result {self.calls}", "records": [
            {"id": "task_08", "name": "Energy review", "energy": 5412.5, "status": "pending", "private": "not-for-display"},
            {"id": "task_09", "name": "Zero energy", "energy": 0, "status": "complete", "private": "not-for-display"},
        ]})


class FixtureProvider(LLMProvider):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.agent_calls = 0
        self.ui_calls = 0
        self.gates = {}

    def get_default_model(self):
        return "offline-openui-browser"

    async def chat(self, messages, **kwargs):
        if current_llm_usage_source() == "user":
            self.agent_calls += 1
        index = max(i for i, row in enumerate(messages) if row["role"] == "user")
        question = str(messages[index]["content"])
        has_result = any(row["role"] == "tool" for row in messages[index + 1:])
        question_line = question.split("\n", 1)[0]
        if question_line in {"Recovery reconnect", "Recovery switch"} and has_result:
            return LLMResponse(content=f"{question_line} answer", tool_calls=[])
        if "Rename this chat to Project plan" in question:
            return LLMResponse(content="Review the proposed conversation title and confirm the change below.", tool_calls=[])
        if "Create an employee survey" in question:
            return LLMResponse(content=SURVEY_ANSWER, tool_calls=[])
        if question.startswith(SURVEY_TITLE + "\n"):
            return LLMResponse(content="已收到本次填写的答案。", tool_calls=[])
        if "Show an interactive category form" in question:
            return LLMResponse(content=CATEGORY_ANSWER, tool_calls=[])
        if question.startswith("Categories\nCategory:"):
            return LLMResponse(content="Category selection received.", tool_calls=[])
        if "Explain variables" in question:
            return LLMResponse(content="A variable stores a value.", tool_calls=[])
        if "Search missing conversations" in question:
            if not has_result:
                return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                    id=uuid4().hex, name="search_sessions", arguments={"query": word},
                ) for word in ["missing-azimuth", "missing-cobalt"]])
            answer = ("Please provide a project keyword to try another search." if "collect a project keyword" in question
                      else "No saved conversations matched either keyword.")
            return LLMResponse(content=answer, tool_calls=[])
        if "Find saved planning conversations" in question:
            if not has_result:
                return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                    id=uuid4().hex, name="search_sessions", arguments={"query": "planning"},
                )])
            return LLMResponse(content="Saved planning conversations are ready to inspect.\n\n"
                               "| Title |\n| --- |\n| Planning notes |\n\nOnly visible saved conversations are included.", tool_calls=[])
        if '"record_id":"websocket:saved-planning"' in question:
            if not has_result:
                return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                    id=uuid4().hex, name="read_session", arguments={"session_key": "websocket:saved-planning"},
                )])
            detail = json.loads(str(messages[-1]["content"]))["messages"][-1]["content"]
            return LLMResponse(content=f"Saved conversation: {detail} Please choose whether to summarize or compare it.", tool_calls=[])
        if "Plan a small project" in question:
            return LLMResponse(content="Please choose whether to define a new project or review an existing draft.", tool_calls=[])
        if "I want to define a new project." in question:
            return LLMResponse(content="Please provide a name and priority to get started.", tool_calls=[])
        if "I want to change the project details first." in question:
            return LLMResponse(content="Here is the current information for editing.", tool_calls=[])
        if "Project details\nProject name:" in question:
            return LLMResponse(content="I have the details. Please confirm when you are ready to prepare the plan.", tool_calls=[])
        if "Confirm the proposed project plan." in question:
            return LLMResponse(content="Confirmed. We can now prepare the plan in this conversation.", tool_calls=[])
        if not any(row["role"] == "tool" for row in messages[index + 1:]):
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                id=uuid4().hex, name="lookup", arguments={},
            )])
        return LLMResponse(content=json.loads(str(messages[-1]["content"]))["summary"], tool_calls=[])

    async def chat_stream(self, messages, *, on_content_delta=None, **kwargs):
        if "Generate only OpenUI Lang" not in str(messages[0].get("content")):
            return await super().chat_stream(messages, on_content_delta=on_content_delta, **kwargs)
        payload = json.loads(messages[-1]["content"])
        self.ui_calls += 1
        datasets = payload["datasets"]
        recovery = payload["public_answer"] in {"Recovery reconnect answer", "Recovery switch answer"}
        if recovery:
            tag = payload["public_answer"].split()[1]
            self.gates[tag] = asyncio.Event()
            source = ('root = Panel([heading, details])\n'
                      + f'heading = Text("Recovery {tag} streaming")\n'
                      + f'details = Form("Recovery {tag} form", [{{label:"Project name",persist:true}}])\n')
        elif datasets and all(not item["row_count"] for item in datasets):
            source = ('root = Panel([details])\ndetails = Form("Search details", [{label: "Project keyword"}])\n'
                      if payload["public_answer"].startswith("Please provide a project keyword") else "root = Panel([])\n")
        elif payload["public_answer"] == SURVEY_ANSWER:
            source = ('root = Panel([survey])\nsurvey = Form('
                      + ', '.join(json.dumps(value, ensure_ascii=False) for value in
                                  (SURVEY_TITLE, SURVEY_FIELDS, SURVEY_DESCRIPTION, "questionnaire")) + ')\n')
        elif payload["public_answer"] == CATEGORY_ANSWER:
            source = ('root = Panel([details])\ndetails = Form("Categories", '
                      + json.dumps(CATEGORY_FIELDS) + ')\n')
        elif datasets and datasets[0]["title"] == "Saved conversations":
            source = ('root = Panel([intro, data], "replace")\n'
                      'intro = Text("Only visible saved conversations are included.")\n'
                      + f'data = DataTable({json.dumps(datasets[0]["data_ref"])})\n')
        elif datasets and payload["question"] == "Show captured charts":
            ref = json.dumps(datasets[0]["data_ref"])
            source = ('root = Panel([bars, trend, share, fields])\n'
                      + f'bars = DataChart({ref}, "name", ["energy"], "bar")\n'
                      + f'trend = DataChart({ref}, "name", ["energy"], "line")\n'
                      + f'share = DataChart({ref}, "name", ["energy"], "pie")\n'
                      + 'fields = Form("Observation", [{label:"Power",type:"number",min:0,max:100,persist:true}, '
                      '{label:"Date",type:"date",persist:true}])\n')
        elif datasets:
            source = ('$question = ""\nroot = Panel([heading, data, followup])\n'
                  'heading = Text("Captured lookup records")\n'
                  + f'data = DataTable({json.dumps(datasets[0]["data_ref"])})\n'
                  + 'followup = Followup($question)\n')
        elif payload["public_answer"].startswith("Review the proposed conversation title"):
            source = ('root = Panel([rename])\nrename = Form("Rename conversation", '
                      '[{label:"New title",type:"text"}], "", "inline", '
                      '{type:"session.rename",title:"Project plan"})\n')
        elif payload["public_answer"].startswith("Please choose whether to define"):
            source = ('root = Panel([next])\nnext = Choices("Where should we start?", ['
                      '{label: "Define the project", question: "I want to define a new project."}, '
                      '{label: "Review a draft", question: "I want to review an existing project draft."}])\n')
        elif payload["public_answer"].startswith("Please provide a name"):
            source = ('root = Panel([details])\ndetails = Form("Project details", ['
                      '{label: "Project name", persist: true, placeholder: "Give your project a name"}, '
                      '{label: "Priority", persist: true, options: ["Normal", "High"]}])\n')
        elif payload["public_answer"] == "Here is the current information for editing.":
            form = payload["conversation_followup"]["form"]
            fields = [{**field, **({"initial": value} if field["persist"] else {})}
                      for field, value in zip(form["fields"], form["values"])]
            source = ('root = Panel([details])\ndetails = Form('
                      + json.dumps(form["title"]) + ', ' + json.dumps(fields) + ')\n')
        elif payload["public_answer"].startswith("I have the details"):
            source = ('root = Panel([confirm])\nconfirm = Choices("Ready to continue?", ['
                      '{label: "Confirm plan", question: "Confirm the proposed project plan."}, '
                      '{label: "Change details", question: "I want to change the project details first."}])\n')
        elif payload["public_answer"].startswith("Saved conversation:"):
            source = ('root = Panel([next])\nnext = Choices("Continue with these notes", ['
                      '{label: "Summarize notes", question: "Summarize the saved planning notes."}, '
                      '{label: "Compare notes", question: "Compare the saved planning notes."}])\n')
        else:
            source = "root = Panel([])\n"
        if on_content_delta is not None:
            boundary = source.index("details =") if recovery else 40
            await on_content_delta(source[:boundary])
            if recovery:
                await self.gates[tag].wait()
            else:
                await asyncio.sleep(0.02)
            await on_content_delta(source[boundary:])
        return LLMResponse(content=source, tool_calls=[])


class RecoveryChannel(WebSocketChannel):
    """Loopback-only fixture controls; all application traffic uses the real gateway."""

    async def _dispatch_http(self, connection, request):
        url = urlsplit(request.path)
        if url.path != "/api/openui-fixture":
            return await super()._dispatch_http(connection, request)
        params = parse_qs(url.query)
        provider = self.fixture_provider
        if "clear" in params:
            if params["clear"] != ["recovery-reset"]:
                return http_json_response({"error": "Unknown reset fixture"}, status=409)
            await SessionClient(self.fixture_agent).clear("websocket:recovery-reset")
        if "release" in params:
            gate = provider.gates.get(params["release"][0])
            if gate is None:
                return http_json_response({"error": "Stream not started"}, status=409)
            gate.set()
        if "disconnect" in params:
            for socket in tuple(self._subs.get(params["disconnect"][0], ())):
                await socket.close(code=1012, reason="Fixture connection interruption")
        return http_json_response({"agent_calls": provider.agent_calls, "ui_calls": provider.ui_calls,
                                   "tool_calls": self.fixture_tool.calls})


async def seed_recovery_history(sessions, runtime):
    """Persist 245 artificial turns and views without invoking a provider or tool."""
    chat_id = "recovery-history"
    key = f"websocket:{chat_id}"
    session = sessions.get_or_create(key)
    session.metadata["webui"] = True
    sessions.save(session)
    facts = []
    for index in range(245):
        turn_id = f"recovery-history-{index}"
        for sequence, (event, phase, text) in enumerate([
            ("user", "user", f"History question {index}"),
            ("message", "answer", f"History answer {index}"),
            ("turn_end", "complete", ""),
        ], start=1):
            facts.append(fact_from_record({"event": event, "turn_id": turn_id,
                "turn_seq": sequence, "turn_phase": phase, "text": text, "created_at_ms": 1793443200000 + index * 1000}))
    await sessions.state.append_history(key, facts, expected_generation=None)
    await sessions.state.read(key)
    scope = await runtime.scope(chat_id)
    assert scope is not None
    for index in range(245):
        block_id = f"history-{index}"
        snapshot = UiSnapshot(chat_id=chat_id, session_generation=scope.generation,
            turn_id=f"recovery-history-{index}", anchor_seq=2, block_id=block_id, library_hash=LIBRARY_HASH,
            fallback_text=f"History answer {index}")
        runtime.store.create(scope, snapshot, state_keys=frozenset({"$question"}))
        source = f'root = Panel([heading])\nheading = Text("History card {index}")\n'
        if index == 0:
            source = '$question = ""\n' + source.replace("[heading]", "[heading, followup]") + 'followup = Followup($question)\n'
        runtime.store.advance(scope, block_id, revision=1, expected_seq=0, delta=source, status="complete")
        if index == 0:
            runtime.store.save_state(scope, block_id, revision=1, expected_state_version=0,
                                     state={"$question": "Saved historical draft"})


def isolated_live_config(path: Path, workspace: Path) -> Config:
    # Keep credentials/generation settings, never production sessions, tools or channels.
    if not path.is_file():
        raise ValueError("LIVE_CONFIG_REQUIRED")
    source = resolve_config_env_vars(load_config(path), config_path=path)
    return Config.model_validate({
        "agents": {"defaults": {"workspace": str(workspace), "modelPreset": "acceptance"}},
        "modelPresets": {"acceptance": source.resolve_preset()},
        "providers": source.providers,
        "network": source.network,
    })


class LiveEvidence(AgentHook):
    """Content-free evidence; the browser can compare counters across refreshes."""

    def __init__(self, path: Path):
        super().__init__()
        self.path = path
        self.trace_path = path.with_suffix(".openui.jsonl")
        self.trace_path.write_text("", encoding="utf-8")
        self.data = {"calls": [], "tools": [], "runs": []}
        self.save()

    def save(self):
        write_text_atomic(self.path, json.dumps(self.data, ensure_ascii=False))

    def observe(self, record):
        self.data["calls"].append(asdict(record))
        self.save()

    def observe_generation(self, message):
        fields = message.record["extra"]
        if fields.get("event") not in {"turn_completed", "openui_model_completed", "openui_job_completed", "openui_job_rejected"}:
            return
        # Copy metrics only: log messages and native response previews can contain user data.
        keys = ("event", "turn_id", "block_id", "revision", "manual_retry_count", "duration_ms", "queue_ms",
                "first_delta_ms", "output_bytes", "retry_waits", "status", "outcome", "reason", "error_code", "error_type",
                "finish_reason", "error_status_code", "model", "max_output_tokens", "reasoning_effort",
                "input_tokens", "output_tokens", "total_tokens")
        with self.trace_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({key: fields[key] for key in keys if key in fields}) + "\n")

    async def after_execute_tool(self, context, tool_call, tool, params, result):
        selection = params.get("session_keys")
        failed = bool(getattr(result, "is_error", False))
        self.data["tools"].append({
            "name": tool_call.name,
            "selected_planning": params.get("session_key") == "websocket:saved-planning",
            "selection_applied": selection is not None,
            "selected_count": len(selection) if selection is not None else None,
            "result_count": len(json.loads(result)["results"]) if tool_call.name == "search_sessions" and not failed else None,
            "error": failed,
        })
        self.save()

    async def on_execute_tool_error(self, context, tool_call, tool, params, error):
        self.data["tools"].append({
            "name": tool_call.name, "error": True, "iteration": context.iteration,
            "parameter_keys": sorted(params), "error_type": type(error).__name__,
            "selected_planning": params.get("session_key") == "websocket:saved-planning",
        })
        self.save()

    async def after_run(self, context):
        self.data["runs"].append({"error": bool(context.error or context.exception),
                                  "stop_reason": context.stop_reason})
        self.save()


async def run(port, live_config=None, evidence_path=None):
    if bool(live_config) != bool(evidence_path):
        raise ValueError("LIVE_CONFIG_AND_EVIDENCE_REQUIRED")
    logger.remove()
    if not live_config:
        logger.add(lambda line: print(line, end="", flush=True), level="WARNING")
    with TemporaryDirectory(prefix="nanobot-openui-browser-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        config = isolated_live_config(Path(live_config), workspace) if live_config else Config.model_validate({
            "agents": {"defaults": {"workspace": str(workspace),
                "model": "openai/offline-openui-browser", "provider": "openai"}},
            "providers": {"openai": {"apiKey": "test-only", "apiBase": "http://127.0.0.1:9/v1"}},
        })
        set_home_path(root)
        set_config_path(root / "config.json")
        save_config(config)
        if live_config:
            (root / "config.json").chmod(0o600)
        preset = config.resolve_preset()
        provider = make_provider(config) if live_config else FixtureProvider(provider_name="offline-browser")
        evidence = LiveEvidence(Path(evidence_path)) if live_config else None
        if evidence:
            provider.set_llm_call_observer(evidence.observe)
            logger.add(evidence.observe_generation)
        bus = MessageBus()
        sessions = SessionManager(workspace)
        saved = sessions.get_or_create("websocket:saved-planning")
        saved.metadata["title"] = "Planning notes"
        saved.add_message("user", "Planning detail: Ship the read-only workflow.")
        if live_config:
            saved.add_message("assistant", "Acceptance code: ORBIT-742. The next step is a read-only release review.")
        sessions.save(saved)
        if live_config:
            current = sessions.get_or_create("websocket:gateway-poc")
            current.metadata["title"] = "Live acceptance"
            sessions.save(current)
            other = sessions.get_or_create("websocket:saved-planning-other")
            other.metadata["title"] = "Planning archive"
            other.add_message("user", "Planning archive: this unrelated record has acceptance code COMET-319.")
            sessions.save(other)
            for key, title, question, answer in [
                ("aurora-lookup", "Aurora lookup request", "查找 aurora 项目的规划。", "只有这次查询，尚无实际方案。"),
                ("meridian-lookup", "Meridian lookup request", "查找 meridian 项目的规划。", "尚未检索到以前的方案。"),
                ("meridian-decisions", "Meridian approved roadmap", "请确定 meridian 项目的范围和下一步。",
                 "此前没找到旧资料。现已确认：只读查询先上线；验收代码 LANTERN-681；下一步是完成权限审查。"),
            ]:
                record = sessions.get_or_create(f"websocket:{key}")
                record.metadata["title"] = title
                record.add_message("user", question)
                record.add_message("assistant", answer)
                sessions.save(record)
        ws_config = WebSocketConfig(host="127.0.0.1", port=port, openui_enabled=True, openui=OpenUIOptions.model_validate({
            "generation": "model", "tables": {"lookup": {"title": "Tasks",
                "columns": {"name": "Name", "energy": "Energy", "status": "Status"}},
                "search_sessions": {"title": "Saved conversations", "recordsKey": "results", "idField": "session_key",
                    "columns": {"title": "Title", "updated_at": "Updated"}}},
        }))
        collector = OpenUICollector(bus, enabled=True, adapters=ws_config.openui.tables)
        services = build_gateway_services(
            config=ws_config, bus=bus, session_manager=sessions, static_dist_path=None,
            workspace_path=workspace, default_restrict_to_workspace=True,
            runtime_model_name=lambda: preset.model, runtime_surface="browser",
            runtime_capabilities_overrides=None, config_path=root / "config.json",
        )
        channel = WebSocketChannel(ws_config, bus, gateway=services) if live_config else RecoveryChannel(ws_config, bus, gateway=services)
        agent = AgentLoop(bus=bus, provider=provider, model=preset.model,
                          workspace=workspace, session_manager=sessions, max_iterations=5,
                          hooks=[evidence] if evidence else [], hook_factories=[collector.hook])
        if live_config:
            for name in agent.tools.tool_names:
                agent.tools.unregister(name)
        else:
            tool = Lookup()
            agent.tools.register(tool)
            channel.fixture_provider = provider
            channel.fixture_tool = tool
            channel.fixture_agent = agent
            await seed_recovery_history(sessions, services.openui)
        agent.tools.register(SearchSessionsTool(sessions))
        agent.tools.register(ReadSessionTool(sessions))
        disconnect = WebuiTurnCoordinator(bus, sessions, schedule_background=asyncio.ensure_future).subscribe()

        async def outbound():
            while True:
                await ChannelManager._send_once(channel, await bus.consume_outbound())

        tasks = [asyncio.create_task(channel.start()), asyncio.create_task(agent.run()),
                 asyncio.create_task(outbound())]
        stop = asyncio.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(signum, stop.set)
        try:
            await stop.wait()
        finally:
            agent.stop()
            await channel.stop()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            disconnect()
            await agent.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    live_config = os.environ.get("NANOBOT_OPENUI_LIVE_CONFIG")
    try:
        asyncio.run(run(args.port, live_config, os.environ.get("NANOBOT_OPENUI_LIVE_EVIDENCE")))
    except Exception as error:
        if not live_config:
            raise
        raise SystemExit(f"Live Gateway failed ({type(error).__name__}); configuration and provider details withheld.") from None
