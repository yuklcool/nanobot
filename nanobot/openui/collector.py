"""Turn-local capture through existing Hook and MessageBus extension points."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from loguru import logger

from nanobot.agent.hook import (
    AgentHook,
    AgentHookContext,
    AgentRunHookContext,
    AgentTurnHookContext,
)
from nanobot.agent.tools.context import current_request_context
from nanobot.bus.events import INBOUND_META_TURN_ID
from nanobot.bus.queue import MessageBus
from nanobot.events import AgentEvent
from nanobot.openui.data import DisplayTable, TableAdapterConfig, capture_table
from nanobot.providers.base import ToolCallRequest
from nanobot.session.display_history import HISTORY_GENERATION_METADATA_KEY
from nanobot.utils.llm_runtime import LLMRuntime


@dataclass(frozen=True)
class UITurnPrepared(AgentEvent):
    chat_id: str
    turn_id: str
    generation: str
    runtime: LLMRuntime | None
    tables: tuple[DisplayTable, ...]
    question: str


class OpenUICollector:
    def __init__(self, bus: MessageBus, *, enabled: bool, adapters: dict[str, TableAdapterConfig]) -> None:
        self.bus = bus
        self.enabled = enabled
        self.adapters = adapters

    def hook(self, context: AgentTurnHookContext) -> AgentHook | None:
        request = current_request_context()
        turn_id = context.metadata.get(INBOUND_META_TURN_ID)
        generation = context.metadata.get(HISTORY_GENERATION_METADATA_KEY)
        if (not self.enabled or context.channel != "websocket" or context.ephemeral
                or context.metadata.get("_openui_mode") not in {"openui", "auto"}
                or not isinstance(turn_id, str) or not isinstance(generation, str)
                or request is None or not request.persist_session):
            return None
        return _Capture(self, context.chat_id, turn_id, generation, request.runtime,
                        (request.original_user_text or "")[:4000])


class _Capture(AgentHook):
    def __init__(
        self, collector: OpenUICollector, chat_id: str, turn_id: str,
        generation: str, runtime: LLMRuntime | None, question: str,
    ) -> None:
        super().__init__()
        self.collector = collector
        self.chat_id, self.turn_id, self.generation = chat_id, turn_id, generation
        self.runtime = runtime
        self.question = question
        self.tables: dict[str, DisplayTable] = {}

    async def after_execute_tool(
        self, context: AgentHookContext, tool_call: ToolCallRequest,
        tool: Any, params: Any, result: Any,
    ) -> None:
        config = self.collector.adapters.get(tool_call.name)
        if config is None or len(self.tables) >= 4:
            return
        try:
            table = capture_table(config, tool_name=tool_call.name, call_id=tool_call.id, result=result)
            if sum(len(item.model_dump_json().encode()) for item in self.tables.values()) + len(table.model_dump_json().encode()) <= 64 * 1024:
                self.tables[table.data_ref] = table
        except (ValueError, TypeError):
            logger.warning("OpenUI display adapter rejected tool={}", tool_call.name)

    async def after_run(self, context: AgentRunHookContext) -> None:
        await self.collector.bus.publish(UITurnPrepared(
            self.chat_id, self.turn_id, self.generation, self.runtime, tuple(self.tables.values()), self.question,
        ))
