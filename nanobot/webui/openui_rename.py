"""One explicitly registered UI write: the current conversation's sidebar title."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore
from nanobot.webui.sidebar_state import rename_webui_sidebar_title, sidebar_title_snapshot


class RenameReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    title: Annotated[str, Field(min_length=1, max_length=160)]
    previous_title: str | None
    expected_revision: str
    status: Literal["prepared", "applied", "conflict", "unknown"]


def rename_operation(
    store: UiSnapshotStore, scope: UiScope, block_id: str, *, revision: int,
    form_id: str, operation: Literal["prepare", "confirm", "status"],
    title: str | None, operation_id: str | None,
) -> UiSnapshot:
    # The fence commits before touching the separate sidebar file. A crash in
    # between leaves an explicit unknown result; no automatic execution/retry.
    with store.transaction() as db:
        block = store._read(db, scope, block_id)
        if block.revision != revision or block.status != "complete":
            raise UiConflictError("STALE_REVISION")
        entries = block.state.get("$renames", {})
        entry = RenameReceipt.model_validate(entries[form_id]) if form_id in entries else None
        if operation == "prepare":
            if title is None:
                raise ValueError("INVALID_PARAMS")
            if entry is not None and entry.status in {"applied", "unknown"}:
                raise UiConflictError("ACTION_ALREADY_SUBMITTED")
            if entry is not None and entry.status == "prepared" and entry.title == title:
                return block
            previous_title, expected_revision = sidebar_title_snapshot(scope.session_key)
            entry = RenameReceipt(operation_id=uuid4().hex, title=title, previous_title=previous_title,
                                  expected_revision=expected_revision, status="prepared")
        elif entry is None or entry.operation_id != operation_id:
            raise UiConflictError("STALE_OPERATION")
        elif operation == "status" or entry.status != "prepared":
            return block
        else:
            entry.status = "unknown"
        updated = UiSnapshot.model_validate({
            **block.model_dump(), "state": {**block.state, "$renames": {**entries, form_id: entry.model_dump()}},
            "state_version": block.state_version + 1,
        })
        store._write(db, scope, updated)
    if operation != "confirm":
        return updated
    applied = rename_webui_sidebar_title(scope.session_key, entry.title, entry.expected_revision)
    with store.transaction() as db:
        current = store._read(db, scope, block_id)
        entries = current.state.get("$renames", {})
        entry.status = "applied" if applied else "conflict"
        updated = UiSnapshot.model_validate({
            **current.model_dump(), "state": {**current.state, "$renames": {**entries, form_id: entry.model_dump()}},
            "state_version": current.state_version + 1,
        })
        store._write(db, scope, updated)
        return updated
