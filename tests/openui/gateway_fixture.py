"""Disposable real Gateway for browser CI; never loads user config or credentials."""

import argparse
import asyncio
import signal
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from loguru import logger

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.bus.queue import MessageBus
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.config.home import set_home_path
from nanobot.config.loader import save_config, set_config_path
from nanobot.config.schema import Config
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.session.manager import SessionManager
from nanobot.session.webui_turns import WebuiTurnCoordinator
from nanobot.webui.gateway_services import build_gateway_services


class Lookup(Tool):
    name = "lookup"
    description = "Return a deterministic test record."
    read_only = True
    parameters = {"type": "object", "properties": {}}

    def __init__(self):
        self.calls = 0

    async def execute(self, **kwargs):
        self.calls += 1
        return f"Lookup result {self.calls}"


class FixtureProvider(LLMProvider):
    def get_default_model(self):
        return "offline-openui-browser"

    async def chat(self, messages, **kwargs):
        index = max(i for i, row in enumerate(messages) if row["role"] == "user")
        if not any(row["role"] == "tool" for row in messages[index + 1:]):
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(
                id=uuid4().hex, name="lookup", arguments={},
            )])
        return LLMResponse(content=str(messages[-1]["content"]), tool_calls=[])


async def run(port):
    logger.remove()
    logger.add(lambda line: print(line, end="", flush=True), level="WARNING")
    with TemporaryDirectory(prefix="nanobot-openui-browser-") as temporary:
        root = Path(temporary)
        set_home_path(root)
        set_config_path(root / "config.json")
        workspace = root / "workspace"
        config = Config.model_validate({"agents": {"defaults": {"workspace": str(workspace)}}})
        save_config(config)
        bus = MessageBus()
        sessions = SessionManager(workspace)
        ws_config = WebSocketConfig(port=port, openui_enabled=True)
        services = build_gateway_services(
            config=ws_config, bus=bus, session_manager=sessions, static_dist_path=None,
            workspace_path=workspace, default_restrict_to_workspace=True,
            runtime_model_name=lambda: "offline-openui-browser", runtime_surface="browser",
            runtime_capabilities_overrides=None, config_path=root / "config.json",
        )
        channel = WebSocketChannel(ws_config, bus, gateway=services)
        agent = AgentLoop(bus=bus, provider=FixtureProvider(provider_name="offline-browser"),
                          workspace=workspace, session_manager=sessions, max_iterations=5)
        agent.tools.register(Lookup())
        disconnect = WebuiTurnCoordinator(bus, sessions, schedule_background=asyncio.ensure_future).subscribe()

        async def outbound():
            while True:
                await channel.send(await bus.consume_outbound())

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
