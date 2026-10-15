import re
from typing import Literal

from pydantic import ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from server.models.recording import RecordingModel


class MixRequest(RecordingModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True,
                              extra="forbid", validate_default=True)
    take_ids: list[str] = Field(min_length=1, max_length=32)
    accompaniment_volume: float = Field(default=0.55, ge=0, le=1, allow_inf_nan=False)
    voice_volume: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)
    master_gain: float = Field(default=1, ge=0, le=2, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_ids(self) -> "MixRequest":
        if len(set(self.take_ids)) != len(self.take_ids) or any(
            not re.fullmatch(r"take_[a-f0-9]{32}", value) for value in self.take_ids
        ):
            raise ValueError("takeIds must contain unique valid IDs")
        self.take_ids.sort()
        return self


class MixJob(RecordingModel):
    job_id: str
    song_id: str
    status: Literal["queued", "processing", "ready", "failed", "stale"]
    range_start_seconds: float
    range_end_seconds: float
    error: str = ""
    created_at: float
