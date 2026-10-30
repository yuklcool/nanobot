"""Durable admission fences for UI-originated Agent turns.

A reserved fence with no acceptance receipt is deliberately not retried: the
process may have queued the turn before crashing. This is at-most-once admission,
not exactly-once execution of arbitrary business tools.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshotStore


class UiActionLedger:
    def __init__(self, store: UiSnapshotStore) -> None:
        self.store = store

    def reserve(
        self, scope: UiScope, *, request_id: str, block_id: str,
        revision: int, content: str, action_id: str = "conversation.followup",
        data_ref: str | None = None, record_id: str | None = None,
    ) -> Literal["new", "accepted", "unknown"]:
        digest = hashlib.sha256(json.dumps(
            [block_id, revision, action_id, data_ref, record_id, content], ensure_ascii=False, separators=(",", ":"),
        ).encode()).hexdigest()
        with self.store.transaction() as db:
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
            return "new"

    def accept(self, scope: UiScope, request_id: str) -> None:
        with self.store.transaction() as db:
            db.execute(
                "UPDATE ui_actions SET status='accepted' WHERE owner=? AND session_key=? "
                "AND generation=? AND request_id=?", (*self.store.key(scope), request_id),
            )
