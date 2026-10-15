import subprocess
from pathlib import Path

from server.models.recording import RecordingTake


def render_mixdown(
    *,
    ffmpeg_executable: str,
    accompaniment: Path,
    takes: list[tuple[RecordingTake, Path]],
    output: Path,
    accompaniment_volume: float,
    voice_volume: float,
    master_gain: float = 1,
) -> None:
    current = [(take, path) for take, path in takes if take.is_current]
    if not current:
        raise ValueError("当前会话没有可混音的音轨")
    range_start = min(take.selection_start_seconds for take, _ in current)
    range_end = max(take.selection_end_seconds for take, _ in current)
    duration = max(range_end - range_start, 0.01)
    audible = [(take, path) for take, path in current if not take.muted]

    command = [ffmpeg_executable, "-hide_banner", "-loglevel", "error", "-y"]
    command.extend(["-i", str(accompaniment)])
    for _, source in audible:
        command.extend(["-i", str(source)])

    filters = [
        f"[0:a]atrim=start={range_start:.6f}:duration={duration:.6f},"
        f"asetpts=PTS-STARTPTS,volume={accompaniment_volume:.6f}[bed]"
    ]
    labels = ["[bed]"]
    for input_index, (take, _) in enumerate(audible, start=1):
        correction = (take.latency_compensation_ms + take.manual_offset_ms) / 1000
        clip_start = take.timeline_start_seconds - correction
        delay = max(0.0, clip_start - range_start)
        trim_start = max(0.0, range_start - clip_start)
        available = max(
            0,
            min(
                (take.client_duration_seconds or
                 take.selection_end_seconds - take.selection_start_seconds) - trim_start,
                duration - delay,
            ),
        )
        if available <= 0:
            continue
        label = f"voice{input_index}"
        filters.append(
            f"[{input_index}:a]atrim=start={trim_start:.6f}:duration={available:.6f},"
            f"asetpts=PTS-STARTPTS,volume={(take.gain * voice_volume):.6f},"
            f"adelay={round(delay * 1000)}:all=1[{label}]"
        )
        labels.append(f"[{label}]")
    filters.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0,"
        f"apad=whole_dur={duration:.6f},atrim=duration={duration:.6f},"
        f"volume={master_gain:.6f}[mix]"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[mix]",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(output),
        ]
    )
    result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
        detail = result.stderr.strip()[-800:]
        raise RuntimeError(f"整体混音生成失败：{detail}")
