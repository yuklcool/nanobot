"""One explicitly registered UI write: the current conversation's sidebar title."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore
from nanobot.webui.sidebar_state import rename_webui_sidebar_title, sidebar_title_snapshot


class RenameReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    title: Annotated[str, Field(min_length=1, max_length=160)]
    previous_title: str | None
    expected_revision: str
    status: Literal["prepared", "applied", "conflict", "unknown"]


_RECEIPTS = TypeAdapter(dict[str, RenameReceipt])


def rename_operation(
    store: UiSnapshotStore, scope: UiScope, block_id: str, *, revision: int,
    form_id: str, operation: Literal["prepare", "confirm", "status"],
    title: str | None, operation_id: str | None, native_title: str | None = None,
) -> UiSnapshot:
    # The fence commits before touching the separate sidebar file. A crash in
    # between leaves an explicit unknown result; no automatic execution/retry.
    with store.transaction() as db:
        block = store._read(db, scope, block_id)
        if block.revision != revision or block.status != "complete":
            raise UiConflictError("STALE_REVISION")
        entries = _RECEIPTS.validate_python(block.state.get("$renames", {}))
        entry = entries.get(form_id)
        if operation == "prepare":
            if title is None:
                raise ValueError("INVALID_PARAMS")
            if entry is not None and entry.status in {"applied", "unknown"}:
                raise UiConflictError("ACTION_ALREADY_SUBMITTED")
            if entry is not None and entry.status == "prepared" and entry.title == title:
                return block
            previous_title, expected_revision = sidebar_title_snapshot(scope.session_key)
            entry = RenameReceipt(operation_id=uuid4().hex, title=title, previous_title=previous_title or native_title,
                                  expected_revision=expected_revision, status="prepared")
        elif entry is None or entry.operation_id != operation_id:
            raise UiConflictError("STALE_OPERATION")
        elif operation == "status" or entry.status != "prepared":
            return block
        else:
            override, _ = sidebar_title_snapshot(scope.session_key)
            entry.status = "conflict" if override is None and native_title != entry.previous_title else "unknown"
        entries[form_id] = entry
        updated = UiSnapshot.model_validate({
            **block.model_dump(), "state": {**block.state, "$renames": {key: item.model_dump() for key, item in entries.items()}},
            "state_version": block.state_version + 1,
        })
        store._write(db, scope, updated)
    if operation != "confirm" or entry.status == "conflict":
        return updated
    applied = rename_webui_sidebar_title(scope.session_key, entry.title, entry.expected_revision)
    with store.transaction() as db:
        current = store._read(db, scope, block_id)
        entries = _RECEIPTS.validate_python(current.state.get("$renames", {}))
        entry.status = "applied" if applied else "conflict"
        entries[form_id] = entry
        updated = UiSnapshot.model_validate({
            **current.model_dump(), "state": {**current.state, "$renames": {key: item.model_dump() for key, item in entries.items()}},
            "state_version": current.state_version + 1,
        })
        store._write(db, scope, updated)
        return updated
