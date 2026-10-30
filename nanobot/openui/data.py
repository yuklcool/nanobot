"""Explicit field allowlists between authorized tool output and public UI data."""

from __future__ import annotations

import hashlib
import time
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, model_validator

from nanobot.config_base import Base

ShortText = Annotated[str, Field(max_length=256)]
Cell = ShortText | bool | int | Annotated[float, Field(allow_inf_nan=False)] | None


class TableAdapterConfig(Base):
    title: Annotated[str, Field(min_length=1, max_length=160)]
    records_key: Annotated[str, Field(max_length=128)] = "records"
    id_field: Annotated[str, Field(min_length=1, max_length=128)] = "id"
    columns: Annotated[dict[str, str], Field(min_length=1, max_length=8)]
    max_rows: Annotated[int, Field(ge=1, le=50)] = 50

    @model_validator(mode="after")
    def valid_columns(self) -> TableAdapterConfig:
        if any(not key or len(key) > 128 or not label or len(label) > 160
               for key, label in self.columns.items()):
            raise ValueError("invalid display columns")
        return self


class DisplayRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    id: Annotated[str, Field(min_length=1, max_length=128)]
    values: dict[str, Cell]


class SessionQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    query: Annotated[str, Field(min_length=1, max_length=500)]
    exclude_session_key: Annotated[str, Field(min_length=1, max_length=512)]


class SessionDetailMessage(BaseModel):
    model_config = ConfigDict(strict=True)
    role: Literal["user", "assistant"]
    content: Annotated[str, Field(max_length=4002)]


class SessionDetail(BaseModel):
    model_config = ConfigDict(strict=True)
    title: Annotated[str, Field(max_length=160)]
    messages: Annotated[list[SessionDetailMessage], Field(max_length=8)]


class DisplayTable(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    data_ref: Annotated[str, Field(min_length=1, max_length=128)]
    title: Annotated[str, Field(min_length=1, max_length=160)]
    columns: Annotated[dict[str, str], Field(min_length=1, max_length=8)]
    rows: Annotated[list[DisplayRow], Field(max_length=50)]
    source_tool: str
    source_call_id: str
    captured_at: float
    total_rows: Annotated[int, Field(ge=0)] = 0
    session_query: SessionQuery | None = None

    def descriptor(self) -> dict[str, JsonValue]:
        return {"data_ref": self.data_ref, "title": self.title,
                "columns": dict(self.columns), "row_count": len(self.rows)}


def capture_table(
    config: TableAdapterConfig, *, tool_name: str, call_id: str, result: object,
) -> DisplayTable:
    if not isinstance(result, str) or len(result.encode("utf-8")) > 256 * 1024:
        raise ValueError("display adapter requires bounded JSON text")
    parsed: JsonValue = TypeAdapter(JsonValue).validate_json(result)
    records: object = parsed.get(config.records_key) if isinstance(parsed, dict) and config.records_key else parsed
    if not isinstance(records, list):
        raise ValueError("display records must be an array")
    rows: list[DisplayRow] = []
    seen: set[str] = set()
    for raw in records[:config.max_rows]:
        if not isinstance(raw, dict):
            raise ValueError("display record must be an object")
        if any(key not in raw for key in config.columns):
            raise ValueError("display field missing")
        identity = raw.get(config.id_field)
        if not isinstance(identity, str) or identity in seen:
            raise ValueError("display IDs must be unique strings")
        seen.add(identity)
        # JSON numbers beyond JavaScript's safe integer range lose digits in
        # transit. Keep their exact decimal representation as literal cells.
        values = {key: str(value) if type(value) is int and abs(value) > 2**53 - 1 else value
                  for key in config.columns for value in [raw.get(key)]}
        rows.append(DisplayRow.model_validate({"id": identity, "values": values}))
    data_ref = "data_" + hashlib.sha256(f"{tool_name}:{call_id}".encode()).hexdigest()[:24]
    table = DisplayTable(data_ref=data_ref, title=config.title, columns=config.columns,
                         rows=rows, source_tool=tool_name, source_call_id=call_id, captured_at=time.time(), total_rows=len(records))
    if len(table.model_dump_json().encode()) > 64 * 1024:
        raise ValueError("display table exceeds size budget")
    return table
