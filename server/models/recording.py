from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class RecordingModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RecordingSelectionType(StrEnum):
    sentence = "sentence"
    segment = "segment"


class TakeSaveMode(StrEnum):
    practice_replace = "practice_replace"
    overdub_append = "overdub_append"


class TakePurpose(StrEnum):
    guided_practice = "guided_practice"
    free_overdub = "free_overdub"


class TakeStatus(StrEnum):
    uploaded = "uploaded"
    processing = "processing"
    aligned = "aligned"
    insufficient_data = "insufficient_data"
    failed = "failed"


class SyncEvent(RecordingModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    kind: Literal[
        "recorder_start_requested", "recorder_started", "recorder_stop_requested",
        "recorder_stopped", "reference_play_requested", "reference_playing",
        "reference_pause", "reference_stop", "reference_ended", "reference_waiting",
        "reference_seek", "reference_error", "interrupted",
    ]
    at_ms: float = Field(ge=0, le=660000, allow_inf_nan=False)
    position_seconds: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)


class SyncEvidence(RecordingModel):
    """Untrusted client event observations, never acoustic calibration proof."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    schema_version: Literal["wechat-sync-v1"]
    clock: Literal["client_wall_ms"]
    playback_rate: Literal[1]
    calibration_status: Literal["unverified", "user_calibrated"]
    calibrated_device_latency_ms: float = Field(ge=-2000, le=2000, allow_inf_nan=False)
    observed_start_gap_ms: float = Field(ge=0, le=3000, allow_inf_nan=False)
    events: list[SyncEvent] = Field(min_length=6, max_length=96)

    @model_validator(mode="after")
    def validate_events(self) -> "SyncEvidence":
        kinds = [event.kind for event in self.events]
        required = ["recorder_start_requested", "recorder_started", "reference_play_requested",
                    "reference_playing", "recorder_stop_requested", "recorder_stopped"]
        if kinds != required:
            raise ValueError("recording requires a complete uninterrupted event sequence")
        if any(b.at_ms < a.at_ms for a, b in zip(self.events, self.events[1:], strict=False)):
            raise ValueError("event times must be ordered")
        gap = self.events[3].at_ms - self.events[1].at_ms
        if abs(gap - self.observed_start_gap_ms) > 1:
            raise ValueError("start gap must match observed events")
        if self.events[3].position_seconds is None:
            raise ValueError("reference start position is required")
        if self.calibration_status == "unverified" and self.calibrated_device_latency_ms != 0:
            raise ValueError("unverified calibration must remain zero")
        return self


class RecordingTake(RecordingModel):
    """One immutable user recording plus mutable selection/playback metadata."""

    take_id: str
    display_name: str = Field(default="未命名轨道", min_length=1, max_length=40)
    session_id: str = Field(min_length=1, max_length=128)
    song_id: str
    # A segment slot includes every selected sentence ID. Full-song Hero ranges can
    # legitimately exceed the old 128-character limit (13 primary lines are ~180).
    track_slot_id: str = Field(min_length=1, max_length=512)
    selection_type: RecordingSelectionType
    sentence_ids: list[str] = Field(min_length=1)
    vocal_part_id: str | None = None
    selection_start_seconds: float = Field(ge=0)
    selection_end_seconds: float = Field(gt=0)
    timeline_start_seconds: float = Field(ge=0)
    save_mode: TakeSaveMode
    purpose: TakePurpose = TakePurpose.guided_practice
    status: TakeStatus = TakeStatus.uploaded
    audio_url: str
    stored_filename: str
    mime_type: str
    size_bytes: int = Field(gt=0)
    client_duration_seconds: float | None = Field(default=None, gt=0)
    latency_compensation_ms: float = 0
    manual_offset_ms: float = 0
    sync_evidence: SyncEvidence | None = None
    gain: float = Field(default=1, ge=0, le=2)
    muted: bool = False
    is_current: bool = True
    superseded_by_take_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def validate_selection(self) -> "RecordingTake":
        if self.selection_end_seconds <= self.selection_start_seconds:
            raise ValueError("selection end must be greater than selection start")
        if self.selection_type == RecordingSelectionType.sentence and len(self.sentence_ids) != 1:
            raise ValueError("sentence selection must contain exactly one sentence ID")
        if self.save_mode == TakeSaveMode.overdub_append and not self.is_current:
            raise ValueError("new overdub takes must remain independently current")
        return self


class RecordingTakeUpdate(RecordingModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    gain: float | None = Field(default=None, ge=0, le=2)
    manual_offset_ms: float | None = Field(default=None, ge=-2000, le=2000)
    muted: bool | None = None

    @model_validator(mode="after")
    def require_update(self) -> "RecordingTakeUpdate":
        if (
            self.display_name is None
            and self.gain is None
            and self.manual_offset_ms is None
            and self.muted is None
        ):
            raise ValueError("at least one take field must be updated")
        if self.display_name is not None:
            self.display_name = self.display_name.strip()
            if not self.display_name:
                raise ValueError("display_name must not be blank")
        return self
