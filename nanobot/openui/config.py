"""Optional WebUI-owned generation and data-adapter settings."""

from typing import Literal

from pydantic import Field

from nanobot.config_base import Base
from nanobot.openui.data import TableAdapterConfig


class OpenUIOptions(Base):
    generation: Literal["preview", "model"] = "preview"
    timeout_seconds: float = Field(default=45, ge=1, le=120)
    max_output_tokens: int = Field(default=4096, ge=128, le=8192)
    concurrency: int = Field(default=2, ge=1, le=4)
    capacity: int = Field(default=16, ge=1, le=32)
    tables: dict[str, TableAdapterConfig] = Field(default_factory=dict)
