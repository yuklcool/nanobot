"""Optional P0 Gateway integration; no changes to Agent execution or prompts.

The initial view is compiled deterministically from already-public answer text.
Model-generated layouts and business data references are a later work package.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nanobot.openui.actions import UiActionLedger
from nanobot.openui.snapshots import (
    Identifier,
    UiConflictError,
    UiScope,
    UiSnapshot,
    UiSnapshotStore,
)
from nanobot.session.display_history import HISTORY_GENERATION_METADATA_KEY, HistoryReader
from nanobot.session.manager import SessionManager
from nanobot.webui.history import turn_records
from nanobot.webui.session_identity import webui_session_key

_MANIFEST = json.loads((Path(__file__).parents[1] / "openui/generated/chat-library.json").read_text())
LIBRARY_HASH: str = _MANIFEST["library_hash"]
CAPABILITY = "webui.openui.p0.v1"


class UiRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    chat_id: Identifier
    turn_ids: Annotated[list[Identifier], Field(max_length=100)] = Field(default_factory=list)


class UiStateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    chat_id: Identifier
    session_generation: Identifier
    block_id: Identifier
    revision: Annotated[int, Field(ge=1)]
    expected_state_version: Annotated[int, Field(ge=0)]
    # Draft persistence is intentionally opt-in in the browser.
    question: Annotated[str, Field(max_length=2000)]


class UiAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    session_generation: Identifier
    block_id: Identifier
    revision: Annotated[int, Field(ge=1)]
    request_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]
    action_id: Literal["conversation.followup"]


class OpenUIRuntime:
    def __init__(self, sessions: SessionManager) -> None:
        self.sessions = sessions
        self.store = UiSnapshotStore(sessions.sessions_dir / "openui.sqlite3")
        self.store.interrupt_streams()
        self.actions = UiActionLedger(self.store)

    @staticmethod
    def capability() -> dict[str, object]:
        return {"protocol": 1, "library_hash": LIBRARY_HASH}

    async def scope(self, chat_id: str) -> UiScope | None:
        # The host authenticates a shared WebUI principal, not isolated tenants.
        # Never use client_id as a purported authenticated user identity.
        key = webui_session_key(chat_id)
        session = await self.sessions.state.read_metadata(key)
        identity = self.sessions.state.peek_identity(key)
        if session is None or identity is None or not identity.policy.persist:
            return None
        if session.get("metadata", {}).get("webui") is not True:
            return None
        return UiScope(owner="webui", session_key=key, generation=identity.generation)

    async def retire_session(self, session_key: str) -> None:
        await self.sessions.state.read_metadata(session_key)
        identity = self.sessions.state.peek_identity(session_key)
        await asyncio.to_thread(self.store.delete_session, "webui", session_key,
                                identity.generation if identity is not None else None)

    async def list_blocks(self, request: UiRequest) -> dict[str, object]:
        scope = await self.scope(request.chat_id)
        blocks = await asyncio.to_thread(self.store.for_turns, scope, request.turn_ids) if scope else []
        return {"capability": self.capability(), "session_generation": scope.generation if scope else None,
                "blocks": [block.model_dump() for block in blocks]}

    async def save_state(self, request: UiStateRequest) -> UiSnapshot:
        scope = await self.scope(request.chat_id)
        if scope is None or scope.generation != request.session_generation:
            raise UiConflictError("STALE_GENERATION")
        block = await asyncio.to_thread(self.store.read, scope, request.block_id)
        if block.library_hash != LIBRARY_HASH:
            raise UiConflictError("UNSUPPORTED_LIBRARY")
        if (block.revision == request.revision
                and block.state_version == request.expected_state_version + 1
                and block.state == {"$question": request.question}):
            return block
        return await asyncio.to_thread(
            self.store.save_state, scope, request.block_id, revision=request.revision,
            expected_state_version=request.expected_state_version, state={"$question": request.question},
        )

    async def admit_action(
        self, chat_id: str, turn_id: str | None, content: str, raw: object,
    ) -> tuple[UiScope, UiAction, Literal["new", "accepted", "unknown"]]:
        action = UiAction.model_validate(raw)
        if turn_id != action.request_id:
            raise ValueError("INVALID_PARAMS")
        if not content.strip() or len(content) > 2000 or content.lstrip().startswith(("/", "!")):
            raise ValueError("INVALID_PARAMS")
        scope = await self.scope(chat_id)
        if scope is None or scope.generation != action.session_generation:
            raise UiConflictError("STALE_GENERATION")
        snapshot = await asyncio.to_thread(self.store.read, scope, action.block_id)
        if snapshot.status != "complete" or snapshot.revision != action.revision:
            raise UiConflictError("STALE_REVISION")
        if snapshot.library_hash != LIBRARY_HASH:
            raise UiConflictError("UNSUPPORTED_LIBRARY")
        result = await asyncio.to_thread(
            self.actions.reserve, scope, request_id=action.request_id,
            block_id=action.block_id, revision=action.revision, content=content,
        )
        return scope, action, result

    async def capture_turn(
        self, chat_id: str, event: dict[str, Any], *, metadata: dict[str, Any] | None,
        emit: Callable[[UiSnapshot], Awaitable[None]],
    ) -> None:
        if (metadata or {}).get("_openui_mode") != "openui":
            return
        turn_id = event.get("turn_id")
        if not isinstance(turn_id, str):
            return

        def last_answer(history: HistoryReader) -> dict[str, Any] | None:
            for turn in history.turns(reverse=True):
                records = turn_records(history, turn.ordinal, max_records=100, max_bytes=512 * 1024)
                for record in reversed(records):
                    if (record.get("turn_id") == turn_id and record.get("turn_phase") == "answer"
                            and record.get("event") in {"message", "stream_end"}
                            and record.get("kind") not in {"progress", "tool_hint", "reasoning"}):
                        return record
                # Only the current, just-completed turn may activate a new view.
                return None
            return None

        answer = await self.sessions.state.project_history(webui_session_key(chat_id), last_answer)
        if answer is not None:
            await self.capture(chat_id, answer, text=answer.get("text"), metadata=metadata, emit=emit)

    async def capture(
        self, chat_id: str, event: dict[str, Any], *, text: str | None,
        metadata: dict[str, Any] | None,
        emit: Callable[[UiSnapshot], Awaitable[None]],
    ) -> None:
        meta = metadata or {}
        if meta.get("_openui_mode") != "openui" or not text or not text.strip():
            return
        turn_id, seq = event.get("turn_id"), event.get("turn_seq")
        if not isinstance(turn_id, str) or type(seq) is not int:
            return
        if event.get("resuming") or event.get("merge_next"):
            return
        scope = await self.scope(chat_id)
        if scope is None or meta.get(HISTORY_GENERATION_METADATA_KEY) != scope.generation:
            return
        block_id = hashlib.sha256(f"{turn_id}:{seq}".encode()).hexdigest()[:32]
        snapshot = UiSnapshot(
            chat_id=chat_id, session_generation=scope.generation, turn_id=turn_id,
            anchor_seq=seq, block_id=block_id, library_hash=LIBRARY_HASH,
        )
        try:
            await asyncio.to_thread(self.store.create, scope, snapshot, state_keys=frozenset({"$question"}))
        except UiConflictError:
            # Re-delivery of an already stored answer is harmless.
            return
        await emit(snapshot)
        # Only the already-public answer enters this minimal compiler; no raw
        # tools, hidden reasoning, remote URLs or executable model output.
        summary = text.encode("utf-16-le")[:32000].decode("utf-16-le", errors="ignore")
        chunks = [f'$question = ""\nroot = Panel([heading, followup])\nheading = Text({json.dumps(summary, ensure_ascii=False)})\n',
                  'followup = Followup($question)\n']
        for chunk in chunks:
            if await self.scope(chat_id) != scope:
                await asyncio.to_thread(self.store.delete_generation, scope)
                return
            snapshot = await asyncio.to_thread(
                self.store.advance, scope, block_id, revision=1, expected_seq=snapshot.seq, delta=chunk,
            )
            await emit(snapshot)
        snapshot = await asyncio.to_thread(
            self.store.advance, scope, block_id, revision=1, expected_seq=snapshot.seq, status="complete",
        )
        await emit(snapshot)


# Exposed for the router's single untrusted request boundary.
REQUEST_ERRORS = (ValidationError, UiConflictError, KeyError, ValueError)
