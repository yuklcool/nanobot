"""Disposable real Gateway for browser CI; never loads user config or credentials."""

import argparse
import asyncio
import json
import signal
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from loguru import logger

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.sessions import ReadSessionTool, SearchSessionsTool
from nanobot.bus.queue import MessageBus
from nanobot.channels.manager import ChannelManager
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.config.home import set_home_path
from nanobot.config.loader import save_config, set_config_path
from nanobot.config.schema import Config
from nanobot.openui.collector import OpenUICollector
from nanobot.openui.config import OpenUIOptions
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.session.manager import SessionManager
from nanobot.session.webui_turns import WebuiTurnCoordinator
from nanobot.webui.gateway_services import build_gateway_services


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
    def get_default_model(self):
        return "offline-openui-browser"

    async def chat(self, messages, **kwargs):
        index = max(i for i, row in enumerate(messages) if row["role"] == "user")
        question = str(messages[index]["content"])
        has_result = any(row["role"] == "tool" for row in messages[index + 1:])
        if "Create an employee survey" in question:
            return LLMResponse(content=SURVEY_ANSWER, tool_calls=[])
        if question.startswith(SURVEY_TITLE + "\n"):
            return LLMResponse(content="已收到本次填写的答案。", tool_calls=[])
        if "Explain variables" in question:
            return LLMResponse(content="A variable stores a value.", tool_calls=[])
        if "Find saved planning conversations" in question:
            if not has_result:
                return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                    id=uuid4().hex, name="search_sessions", arguments={"query": "planning"},
                )])
            return LLMResponse(content="Saved planning conversations are ready to inspect.", tool_calls=[])
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
        datasets = payload["datasets"]
        if payload["public_answer"] == SURVEY_ANSWER:
            source = ('root = Panel([survey])\nsurvey = Form('
                      + ', '.join(json.dumps(value, ensure_ascii=False) for value in
                                  (SURVEY_TITLE, SURVEY_FIELDS, SURVEY_DESCRIPTION, "questionnaire")) + ')\n')
        elif datasets and datasets[0]["title"] == "Saved conversations":
            source = 'root = Panel([data])\n' + f'data = DataTable({json.dumps(datasets[0]["data_ref"])})\n'
        elif datasets:
            source = ('$question = ""\nroot = Panel([heading, data, followup])\n'
                  'heading = Text("Captured lookup records")\n'
                  + f'data = DataTable({json.dumps(datasets[0]["data_ref"])})\n'
                  + 'followup = Followup($question)\n')
        elif payload["public_answer"].startswith("Please choose whether to define"):
            source = ('root = Panel([next])\nnext = Choices("Where should we start?", ['
                      '{label: "Define the project", question: "I want to define a new project."}, '
                      '{label: "Review a draft", question: "I want to review an existing project draft."}])\n')
        elif payload["public_answer"].startswith("Please provide a name"):
            source = ('root = Panel([details])\ndetails = Form("Project details", ['
                      '{label: "Project name", persist: true, placeholder: "Give your project a name"}, '
                      '{label: "Priority", persist: true, options: ["Normal", "High"]}])\n')
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
            await on_content_delta(source[:40])
            await asyncio.sleep(0.02)
            await on_content_delta(source[40:])
        return LLMResponse(content=source, tool_calls=[])


async def run(port):
    logger.remove()
    logger.add(lambda line: print(line, end="", flush=True), level="WARNING")
    with TemporaryDirectory(prefix="nanobot-openui-browser-") as temporary:
        root = Path(temporary)
        set_home_path(root)
        set_config_path(root / "config.json")
        workspace = root / "workspace"
        config = Config.model_validate({
            "agents": {"defaults": {"workspace": str(workspace),
                "model": "openai/offline-openui-browser", "provider": "openai"}},
            "providers": {"openai": {"apiKey": "test-only", "apiBase": "http://127.0.0.1:9/v1"}},
        })
        save_config(config)
        bus = MessageBus()
        sessions = SessionManager(workspace)
        saved = sessions.get_or_create("websocket:saved-planning")
        saved.metadata["title"] = "Planning notes"
        saved.add_message("user", "Planning detail: Ship the read-only workflow.")
        sessions.save(saved)
        ws_config = WebSocketConfig(port=port, openui_enabled=True, openui=OpenUIOptions.model_validate({
            "generation": "model", "tables": {"lookup": {"title": "Tasks",
                "columns": {"name": "Name", "energy": "Energy", "status": "Status"}},
                "search_sessions": {"title": "Saved conversations", "recordsKey": "results", "idField": "session_key",
                    "columns": {"title": "Title", "updated_at": "Updated"}}},
        }))
        collector = OpenUICollector(bus, enabled=True, adapters=ws_config.openui.tables)
        services = build_gateway_services(
            config=ws_config, bus=bus, session_manager=sessions, static_dist_path=None,
            workspace_path=workspace, default_restrict_to_workspace=True,
            runtime_model_name=lambda: "offline-openui-browser", runtime_surface="browser",
            runtime_capabilities_overrides=None, config_path=root / "config.json",
        )
        channel = WebSocketChannel(ws_config, bus, gateway=services)
        agent = AgentLoop(bus=bus, provider=FixtureProvider(provider_name="offline-browser"),
                          workspace=workspace, session_manager=sessions, max_iterations=5,
                          hook_factories=[collector.hook])
        agent.tools.register(Lookup())
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
    asyncio.run(run(parser.parse_args().port))
