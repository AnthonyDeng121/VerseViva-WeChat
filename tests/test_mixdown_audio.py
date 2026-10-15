import array
import math
import shutil
import subprocess
import wave

import pytest

from server.models.recording import RecordingTake
from server.services.mixdown import render_mixdown


def tone(path, duration, amplitude=0.1):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        values = array.array("h", [int(amplitude * 32767 * math.sin(2 * math.pi * 440 * i / 16000))
                                  for i in range(int(duration * 16000))])
        output.writeframes(values.tobytes())


def samples(path):
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le",
                             "-ac", "1", "-ar", "16000", "-"], capture_output=True,
                            timeout=10, check=True)
    values = array.array("h")
    values.frombytes(result.stdout)
    return values


def rms(values, start, end):
    window = values[int(start * 16000):int(end * 16000)]
    return math.sqrt(sum(value * value for value in window) / len(window))


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="requires ffmpeg")
def test_real_mix_offsets_gains_mute_and_continuous_accompaniment(tmp_path):
    bed, voice = tmp_path / "bed.wav", tmp_path / "voice.wav"
    tone(bed, 4, 0.02)
    tone(voice, 1)
    base = RecordingTake(take_id="take_" + "a" * 32, session_id="owner", song_id="song_test",
                         track_slot_id="slot", selection_type="sentence", sentence_ids=["s"],
                         selection_start_seconds=0.5, selection_end_seconds=1.5,
                         timeline_start_seconds=1, latency_compensation_ms=100,
                         manual_offset_ms=200, save_mode="overdub_append", audio_url="",
                         stored_filename="voice.wav", mime_type="audio/wav", size_bytes=1,
                         client_duration_seconds=1)
    second = base.model_copy(update={"take_id": "take_" + "b" * 32,
                                     "selection_start_seconds": 3, "selection_end_seconds": 3.5,
                                     "timeline_start_seconds": 3, "latency_compensation_ms": 0,
                                     "manual_offset_ms": -200, "muted": True})
    output = tmp_path / "mix.mp3"
    arguments = dict(ffmpeg_executable="ffmpeg", accompaniment=bed,
                     takes=[(base, voice), (second, voice)], output=output,
                     accompaniment_volume=0, voice_volume=1)
    render_mixdown(**arguments)
    values = samples(output)
    assert abs(len(values) / 16000 - 3) < 0.08
    assert rms(values, 0.03, 0.1) < 20  # .7 absolute start, .2 into selected range
    level = rms(values, 0.4, 0.6)
    assert level > 1000
    assert rms(values, 1.6, 2) < 20
    assert rms(values, 2.8, 2.95) < 20  # muted second still determines continuous range
    base.gain = 0.5
    render_mixdown(**arguments, master_gain=0.5)
    assert 0.22 < rms(samples(output), 0.4, 0.6) / level < 0.28
    second.muted = False
    render_mixdown(**arguments)
    values = samples(output)
    assert rms(values, 2.5, 2.6) < 20
    assert rms(values, 2.8, 2.95) > 1000  # negative manual offset delays the second Take
    base.muted = True
    second.muted = True
    arguments["accompaniment_volume"] = 1
    render_mixdown(**arguments)
    values = samples(output)
    assert rms(values, 1.6, 2) > 300  # no Take here, backing must continue
    assert rms(values, 2.8, 2.95) > 300
