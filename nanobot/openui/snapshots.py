"""Bounded, generation-scoped UI snapshots for the OpenUI integration spike.

This store is not an authorization layer or an event outbox. Callers must resolve
the scope from an authenticated host and authorize it before calling the store.
The synchronous API belongs off the event loop when wired into the gateway.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Generator, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator

MAX_SOURCE_BYTES = 128 * 1024
MAX_STATE_BYTES = 16 * 1024
Identifier = Annotated[str, Field(min_length=1, max_length=128)]
Status = Literal["streaming", "complete", "failed", "cancelled", "superseded"]


class UiScope(BaseModel):
    """Trusted host identity; never construct from client-supplied scope fields."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    owner: Identifier
    session_key: Annotated[str, Field(min_length=1, max_length=512)]
    generation: Identifier


class UiSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    schema_version: Literal[1] = 1
    chat_id: Identifier
    session_generation: Identifier
    turn_id: Identifier
    block_id: Identifier
    revision: Annotated[int, Field(ge=1)] = 1
    seq: Annotated[int, Field(ge=0)] = 0
    library_hash: Identifier
    status: Status = "streaming"
    source: str = ""
    state: dict[str, JsonValue] = Field(default_factory=dict)
    state_version: Annotated[int, Field(ge=0)] = 0

    @field_validator("source")
    @classmethod
    def bounded_source(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValueError("UI source exceeds size limit")
        return value

    @field_validator("state")
    @classmethod
    def bounded_state(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_STATE_BYTES:
            raise ValueError("UI state exceeds size limit")
        return value


class UiConflictError(ValueError):
    """The source/state revision changed, ended, or belongs to a deleted session."""


class UiSnapshotStore:
    """A small restart-safe snapshot store, with independent state CAS."""

    def __init__(self, path: Path) -> None:
        # The host owns path selection, directory creation and access control.
        self.path = path
        with self._transaction() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise UiConflictError("unsupported UI database version")
            db.execute("""CREATE TABLE IF NOT EXISTS ui_snapshots (
                owner TEXT NOT NULL, session_key TEXT NOT NULL, generation TEXT NOT NULL,
                block_id TEXT NOT NULL, snapshot TEXT NOT NULL, state_keys TEXT NOT NULL,
                PRIMARY KEY(owner, session_key, generation, block_id))""")
            db.execute("""CREATE TABLE IF NOT EXISTS ui_tombstones (
                owner TEXT NOT NULL, session_key TEXT NOT NULL, generation TEXT NOT NULL,
                PRIMARY KEY(owner, session_key, generation))""")
            db.execute("PRAGMA user_version = 1")

    @contextmanager
    def _transaction(self) -> Generator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("PRAGMA synchronous = FULL")
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _key(scope: UiScope) -> tuple[str, str, str]:
        return scope.owner, scope.session_key, scope.generation

    def _read(
        self, db: sqlite3.Connection, scope: UiScope, block_id: str,
    ) -> UiSnapshot:
        row = db.execute(
            "SELECT snapshot FROM ui_snapshots WHERE owner=? AND session_key=? "
            "AND generation=? AND block_id=?", (*self._key(scope), block_id),
        ).fetchone()
        if row is None:
            raise KeyError("UI block unavailable")
        return UiSnapshot.model_validate_json(row[0])

    def _write(self, db: sqlite3.Connection, scope: UiScope, snapshot: UiSnapshot) -> None:
        db.execute(
            "UPDATE ui_snapshots SET snapshot=? WHERE owner=? AND session_key=? "
            "AND generation=? AND block_id=?",
            (snapshot.model_dump_json(), *self._key(scope), snapshot.block_id),
        )

    def create(
        self, scope: UiScope, snapshot: UiSnapshot, *, state_keys: frozenset[str] = frozenset(),
    ) -> None:
        if snapshot.session_generation != scope.generation:
            raise UiConflictError("session generation mismatch")
        if snapshot.seq != 0 or snapshot.status != "streaming" or snapshot.source:
            raise UiConflictError("new block must start as an empty stream")
        if snapshot.state or snapshot.state_version != 0:
            raise UiConflictError("new block cannot contain persisted state")
        if len(state_keys) > 64 or any(not key or len(key) > 128 for key in state_keys):
            raise ValueError("invalid state allowlist")
        with self._transaction() as db:
            if db.execute(
                "SELECT 1 FROM ui_tombstones WHERE owner=? AND session_key=? AND generation=?",
                self._key(scope),
            ).fetchone():
                raise UiConflictError("session generation was deleted")
            try:
                db.execute("INSERT INTO ui_snapshots VALUES (?, ?, ?, ?, ?, ?)", (
                    *self._key(scope), snapshot.block_id, snapshot.model_dump_json(),
                    json.dumps(sorted(state_keys)),
                ))
            except sqlite3.IntegrityError as exc:
                raise UiConflictError("UI block already exists") from exc

    def read(self, scope: UiScope, block_id: str) -> UiSnapshot:
        with self._transaction() as db:
            return self._read(db, scope, block_id)

    def advance(
        self, scope: UiScope, block_id: str, *, revision: int, expected_seq: int,
        delta: str = "", status: Status = "streaming",
    ) -> UiSnapshot:
        with self._transaction() as db:
            current = self._read(db, scope, block_id)
            if (current.revision != revision or current.seq != expected_seq
                    or current.status != "streaming"):
                raise UiConflictError("UI stream changed or ended")
            if status == "streaming" and not delta:
                raise ValueError("stream delta cannot be empty")
            # Revalidate the whole record; model_copy(update=...) skips validation.
            updated = UiSnapshot.model_validate({
                **current.model_dump(), "source": current.source + delta,
                "seq": current.seq + 1, "status": status,
            })
            self._write(db, scope, updated)
            return updated

    def save_state(
        self, scope: UiScope, block_id: str, *, revision: int,
        expected_state_version: int, state: dict[str, JsonValue],
    ) -> UiSnapshot:
        with self._transaction() as db:
            current = self._read(db, scope, block_id)
            if (current.revision != revision or current.state_version != expected_state_version
                    or current.status != "complete"):
                raise UiConflictError("UI state changed or is not editable")
            row = db.execute(
                "SELECT state_keys FROM ui_snapshots WHERE owner=? AND session_key=? "
                "AND generation=? AND block_id=?", (*self._key(scope), block_id),
            ).fetchone()
            allowed = json.loads(row[0])
            if any(key not in allowed for key in state):
                raise ValueError("state field is not allowed for persistence")
            updated = UiSnapshot.model_validate({
                **current.model_dump(), "state": state,
                "state_version": current.state_version + 1,
            })
            self._write(db, scope, updated)
            return updated

    def delete_generation(self, scope: UiScope) -> None:
        with self._transaction() as db:
            db.execute("INSERT OR IGNORE INTO ui_tombstones VALUES (?, ?, ?)", self._key(scope))
            db.execute(
                "DELETE FROM ui_snapshots WHERE owner=? AND session_key=? AND generation=?",
                self._key(scope),
            )
