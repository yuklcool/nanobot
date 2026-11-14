"""Bounded conversation-form drafts; these schemas grant no tool permissions."""

from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from datetime import date
from typing import Annotated, Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore

MAX_FORM_OPTIONS = 50


class FormCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    field: Annotated[int, Field(ge=0, le=11)]
    value: Annotated[str, Field(min_length=1, max_length=120)]


FormValue = Annotated[str, Field(max_length=400)] | Annotated[
    list[Annotated[str, Field(min_length=1, max_length=120)]], Field(max_length=MAX_FORM_OPTIONS),
]


class FormField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: Annotated[str, Field(min_length=1, max_length=80)]
    placeholder: Annotated[str, Field(max_length=120)] | None = None
    options: Annotated[list[Annotated[str, Field(min_length=1, max_length=120)]], Field(min_length=2, max_length=MAX_FORM_OPTIONS)] | None = None
    persist: bool = False
    required: bool = True
    type: Literal["text", "number", "date", "select", "radio", "checkbox"] | None = None
    min: Annotated[float, Field(allow_inf_nan=False)] | None = None
    max: Annotated[float, Field(allow_inf_nan=False)] | None = None
    when: FormCondition | None = None
    initial: FormValue | None = None

    @model_validator(mode="after")
    def valid_initial(self) -> FormField:
        if ((self.min is not None or self.max is not None) and self.type != "number"
                or self.min is not None and self.max is not None and self.min > self.max):
            raise ValueError("INVALID_NUMERIC_BOUNDS")
        if self.initial is not None:
            selected = self.initial if isinstance(self.initial, list) else [self.initial] if self.initial else []
            if (not self.persist or (self.type == "checkbox") != isinstance(self.initial, list)
                    or (self.options and (len(set(selected)) != len(selected)
                                         or any(item not in self.options for item in selected)))
                    or isinstance(self.initial, str) and not self.scalar_valid(self.initial)):
                raise ValueError("INVALID_INITIAL_VALUE")
        return self

    def scalar_valid(self, value: str) -> bool:
        if not value:
            return True
        if self.type == "number":
            if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value, flags=re.ASCII):
                return False
            number = float(value)
            return (math.isfinite(number) and (self.min is None or number >= self.min)
                    and (self.max is None or number <= self.max))
        if self.type == "date":
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
                return False
            try:
                date.fromisoformat(value)
            except ValueError:
                return False
        return True


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
                    or (field.type in {"text", "number", "date"} and field.options)
                    or (field.options and len(set(field.options)) != len(field.options))):
                raise ValueError("INVALID_PARAMS")
            if field.when:
                source_options = self.fields[field.when.field].options if field.when.field < index else None
                if not source_options or field.when.value not in source_options:
                    raise ValueError("INVALID_PARAMS")
            if (field.type == "checkbox") != isinstance(value, list):
                raise ValueError("INVALID_PARAMS")
            if not visible[index]:
                self.values[index] = [] if field.type == "checkbox" else ""
                continue
            if self.submit and field.required and not (value if isinstance(value, list) else value.strip()):
                raise ValueError("INVALID_PARAMS")
            if isinstance(value, str) and not field.scalar_valid(value):
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


class ConversationFollowup(BaseModel):
    """Data carried by an admitted UI action, never an execution permission."""

    model_config = ConfigDict(extra="forbid", strict=True)
    form: ConversationForm | None = None


def form_followup(block: UiSnapshot, form_id: str | None) -> ConversationFollowup:
    if form_id is None:
        return ConversationFollowup.model_validate(block.state.get("$followup", {}))
    forms = cast(dict[str, dict[str, Any]], block.state.get("$forms", {}))
    entry = forms.get(form_id, {})
    # Older cards have only a schema digest; do not guess their missing fields.
    if "definition" not in entry:
        return ConversationFollowup()
    return ConversationFollowup(form=ConversationForm.model_validate({
        **entry["definition"], "form_id": form_id, "values": entry["values"], "submit": False,
    }))


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
        block = store.read_in_transaction(db, scope, block_id)
        if block.revision != revision or block.status != "complete":
            raise UiConflictError("STALE_REVISION")
        forms = dict(cast(dict[str, dict[str, Any]], block.state.get("$forms", {})))
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
        definition = form.model_dump(mode="json", exclude_none=True, exclude={
            "form_id": True, "values": True, "submit": True, "fields": {"__all__": {"initial"}},
        })
        entry: dict[str, Any] = {"schema": schema, "values": values, "status": "draft", "definition": definition}
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
        store.write_in_transaction(db, scope, updated)
        return updated
