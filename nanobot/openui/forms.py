"""Bounded conversation-form drafts; these schemas grant no tool permissions."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore


class FormCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    field: Annotated[int, Field(ge=0, le=11)]
    value: Annotated[str, Field(min_length=1, max_length=120)]


FormValue = Annotated[str, Field(max_length=400)] | Annotated[
    list[Annotated[str, Field(min_length=1, max_length=120)]], Field(max_length=6),
]


class FormField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: Annotated[str, Field(min_length=1, max_length=80)]
    placeholder: Annotated[str, Field(max_length=120)] | None = None
    options: Annotated[list[Annotated[str, Field(min_length=1, max_length=120)]], Field(min_length=2, max_length=6)] | None = None
    persist: bool = False
    required: bool = True
    type: Literal["text", "select", "radio", "checkbox"] | None = None
    when: FormCondition | None = None
    initial: FormValue | None = None

    @model_validator(mode="after")
    def valid_initial(self) -> FormField:
        if self.initial is not None:
            selected = self.initial if isinstance(self.initial, list) else [self.initial] if self.initial else []
            if (not self.persist or (self.type == "checkbox") != isinstance(self.initial, list)
                    or (self.options and (len(set(selected)) != len(selected)
                                         or any(item not in self.options for item in selected)))):
                raise ValueError("INVALID_INITIAL_VALUE")
        return self


class ConversationForm(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    form_id: Annotated[str, Field(pattern=r"^form-[0-5]$")]
    title: Annotated[str, Field(min_length=1, max_length=160)]
    fields: Annotated[list[FormField], Field(min_length=1, max_length=12)]
    description: Annotated[str, Field(max_length=600)] | None = None
    presentation: Literal["inline", "questionnaire"] | None = None
    values: Annotated[list[FormValue], Field(min_length=1, max_length=12)]
    submit: bool = False

    @model_validator(mode="after")
    def valid_values(self) -> ConversationForm:
        if len(self.values) != len(self.fields):
            raise ValueError("INVALID_PARAMS")
        visible = self.visible()
        for index, (field, value) in enumerate(zip(self.fields, self.values)):
            if ((field.type in {"select", "radio", "checkbox"} and not field.options)
                    or (field.type == "text" and field.options)
                    or (field.options and len(set(field.options)) != len(field.options))):
                raise ValueError("INVALID_PARAMS")
            if field.when and (field.when.field >= index or not self.fields[field.when.field].options
                               or field.when.value not in self.fields[field.when.field].options):
                raise ValueError("INVALID_PARAMS")
            if (field.type == "checkbox") != isinstance(value, list):
                raise ValueError("INVALID_PARAMS")
            if not visible[index]:
                self.values[index] = [] if field.type == "checkbox" else ""
                continue
            if self.submit and field.required and not (value if isinstance(value, list) else value.strip()):
                raise ValueError("INVALID_PARAMS")
            selected = value if isinstance(value, list) else [value] if value else []
            if field.options and (len(set(selected)) != len(selected) or any(item not in field.options for item in selected)):
                raise ValueError("INVALID_PARAMS")
            if isinstance(value, list):
                self.values[index] = [option for option in field.options or [] if option in value]
            if not self.submit and not field.persist and value:
                raise ValueError("FIELD_NOT_PERSISTABLE")
        if self.submit and len(self.content()) > 4000:
            raise ValueError("FORM_TOO_LONG")
        return self

    def visible(self) -> list[bool]:
        visible: list[bool] = []
        for index, field in enumerate(self.fields):
            condition = field.when
            if condition is None:
                visible.append(True)
                continue
            if condition.field >= index:
                visible.append(False)
                continue
            value = self.values[condition.field]
            visible.append(visible[condition.field] and (condition.value in value if isinstance(value, list) else value == condition.value))
        return visible

    def content(self) -> str:
        return "\n".join([self.title, *(
            f"{field.label}: {', '.join(value) if isinstance(value, list) else value.strip()}"
            for field, value, visible in zip(self.fields, self.values, self.visible()) if visible
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
        [form.title, [field.model_dump() for field in form.fields], form.description, form.presentation],
        ensure_ascii=False, sort_keys=True,
    ))
    values = [value if field.persist else [] if field.type == "checkbox" else ""
              for field, value in zip(form.fields, form.values)]
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
