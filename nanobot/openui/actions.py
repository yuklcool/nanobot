"""Durable admission fences for UI-originated Agent turns.

A reserved fence with no acceptance receipt is deliberately not retried: the
process may have queued the turn before crashing. This is at-most-once admission,
not exactly-once execution of arbitrary business tools.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from nanobot.openui.forms import content_digest
from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore


class UiActionLedger:
    def __init__(self, store: UiSnapshotStore) -> None:
        self.store = store

    def reserve(
        self, scope: UiScope, *, request_id: str, block_id: str,
        revision: int, content: str, action_id: str = "conversation.followup",
        data_ref: str | None = None, record_id: str | None = None,
        form_id: str | None = None,
    ) -> Literal["new", "accepted", "unknown"]:
        digest = hashlib.sha256(json.dumps(
            [block_id, revision, action_id, data_ref, record_id, content], ensure_ascii=False, separators=(",", ":"),
        ).encode()).hexdigest()
        with self.store.transaction() as db:
            block = self.store._read(db, scope, block_id) if form_id else None
            if block is not None:
                entry = block.state.get("$forms", {}).get(form_id)
                if (block.revision != revision or block.status != "complete" or not entry
                        or entry.get("request_id") != request_id
                        or entry.get("content_digest") != content_digest(content)):
                    raise UiConflictError("ACTION_NOT_ALLOWED")
            row = db.execute(
                "SELECT digest, status FROM ui_actions WHERE owner=? AND session_key=? "
                "AND generation=? AND request_id=?", (*self.store.key(scope), request_id),
            ).fetchone()
            if row is not None:
                if row[0] != digest:
                    raise UiConflictError("IDEMPOTENCY_CONFLICT")
                return "accepted" if row[1] == "accepted" else "unknown"
            db.execute("INSERT INTO ui_actions VALUES (?, ?, ?, ?, ?, 'reserved')", (
                *self.store.key(scope), request_id, digest,
            ))
            if block is not None:
                entry["status"] = "unknown"
                updated = UiSnapshot.model_validate({**block.model_dump(), "state_version": block.state_version + 1})
                self.store._write(db, scope, updated)
            return "new"

    def accept(
        self, scope: UiScope, request_id: str, *, block_id: str | None = None,
        revision: int | None = None, form_id: str | None = None,
    ) -> UiSnapshot | None:
        with self.store.transaction() as db:
            db.execute(
                "UPDATE ui_actions SET status='accepted' WHERE owner=? AND session_key=? "
                "AND generation=? AND request_id=?", (*self.store.key(scope), request_id),
            )
            if form_id is not None and block_id is not None:
                block = self.store._read(db, scope, block_id)
                entry = block.state.get("$forms", {}).get(form_id)
                if block.revision == revision and entry and entry.get("request_id") == request_id:
                    entry["status"] = "submitted"
                    updated = UiSnapshot.model_validate({**block.model_dump(), "state_version": block.state_version + 1})
                    self.store._write(db, scope, updated)
                    return updated
        return None
