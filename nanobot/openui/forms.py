"""Bounded conversation-form drafts; these schemas grant no tool permissions."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore


class FormField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: Annotated[str, Field(min_length=1, max_length=80)]
    placeholder: Annotated[str, Field(max_length=120)] | None = None
    options: Annotated[list[Annotated[str, Field(min_length=1, max_length=120)]], Field(min_length=2, max_length=6)] | None = None
    persist: bool = False


class ConversationForm(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    form_id: Annotated[str, Field(pattern=r"^form-[0-5]$")]
    title: Annotated[str, Field(min_length=1, max_length=160)]
    fields: Annotated[list[FormField], Field(min_length=1, max_length=3)]
    values: Annotated[list[Annotated[str, Field(max_length=400)]], Field(min_length=1, max_length=3)]
    submit: bool = False

    @model_validator(mode="after")
    def valid_values(self) -> ConversationForm:
        if len(self.values) != len(self.fields):
            raise ValueError("INVALID_PARAMS")
        for field, value in zip(self.fields, self.values):
            if self.submit and not value.strip():
                raise ValueError("INVALID_PARAMS")
            if value and field.options is not None and value not in field.options:
                raise ValueError("INVALID_PARAMS")
            if not self.submit and not field.persist and value:
                raise ValueError("FIELD_NOT_PERSISTABLE")
        return self

    def content(self) -> str:
        return "\n".join([self.title, *(
            f"{field.label}: {value.strip()}" for field, value in zip(self.fields, self.values)
        )])


def content_digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def save_form(
    store: UiSnapshotStore, scope: UiScope, block_id: str, *, revision: int,
    expected_state_version: int, form: ConversationForm,
) -> UiSnapshot:
    # The client uses the official Lang renderer. Its bounded display schema is
    # untrusted user input, never a business schema or an authorization source.
    schema = content_digest(json.dumps(
        [form.title, [field.model_dump() for field in form.fields]], ensure_ascii=False, sort_keys=True,
    ))
    values = [value if field.persist else "" for field, value in zip(form.fields, form.values)]
    with store.transaction() as db:
        block = store._read(db, scope, block_id)
        if block.revision != revision or block.status != "complete":
            raise UiConflictError("STALE_REVISION")
        forms = dict(block.state.get("$forms", {}))
        previous = forms.get(form.form_id)
        if previous and previous["schema"] != schema:
            raise UiConflictError("FORM_CHANGED")
        digest = content_digest(form.content()) if form.submit else None
        if previous and previous.get("request_id"):
            if form.submit and previous["content_digest"] != digest:
                raise UiConflictError("IDEMPOTENCY_CONFLICT")
            if not form.submit and previous["values"] != values:
                raise UiConflictError("FORM_LOCKED")
            return block
        entry = {"schema": schema, "values": values, "status": "draft"}
        if form.submit:
            entry.update(request_id=str(uuid.uuid4()), content_digest=digest, status="prepared")
        if previous == entry:
            return block
        if block.state_version != expected_state_version:
            raise UiConflictError("STALE_STATE")
        forms[form.form_id] = entry
        updated = UiSnapshot.model_validate({
            **block.model_dump(), "state": {**block.state, "$forms": forms},
            "state_version": block.state_version + 1,
        })
        store._write(db, scope, updated)
        return updated
