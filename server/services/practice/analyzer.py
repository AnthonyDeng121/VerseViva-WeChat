import asyncio
import json
import re
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx
from pydantic import ValidationError

from server.models.practice import LanguageIssueType
from server.models.song import LanguageHint, SongSentence, VocalPart
from server.pipelines.language_coach import _is_retryable_gemini_error
from server.services.practice.models import AcousticFinding, AcousticFindingBatch, FindingResult
from server.services.provider_files import delete_provider_file


class GeminiPracticeAnalyzer:
    provider = "gemini"

    def __init__(self, api_key: str, model: str, request_timeout_seconds: float = 60) -> None:
        if not api_key:
            raise ValueError("Gemini API key is required for practice analysis")
        self.api_key = api_key
        self.model = model
        self.request_timeout_seconds = request_timeout_seconds

    def _client(self):
        from google import genai

        # SDK timeout is milliseconds; retries belong to our bounded batch loop.
        return genai.Client(api_key=self.api_key, http_options={
            "timeout": int(self.request_timeout_seconds * 1000),
            "retry_options": {"attempts": 1},
        })

    async def analyze(
        self,
        audio_path: Path,
        sentences: list[SongSentence],
        reference_vocal_path: Path | None = None,
        recording_start_seconds: float = 0,
    ) -> AcousticFindingBatch:
        return await asyncio.to_thread(
            self._analyze_sync,
            audio_path,
            sentences,
            reference_vocal_path,
            recording_start_seconds,
        )

    async def analyze_secondary(
        self,
        audio_path: Path,
        reference_vocal_path: Path,
        vocal_parts: list[VocalPart],
        targets: list[dict],
        recording_start_seconds: float,
    ) -> AcousticFindingBatch:
        return await asyncio.to_thread(
            self._analyze_secondary_sync,
            audio_path,
            reference_vocal_path,
            vocal_parts,
            targets,
            recording_start_seconds,
        )

    def _analyze_secondary_sync(
        self,
        audio_path: Path,
        reference_vocal_path: Path,
        vocal_parts: list[VocalPart],
        targets: list[dict],
        recording_start_seconds: float = 0,
    ) -> AcousticFindingBatch:
        findings: list[AcousticFinding] = []
        with _gemini_compatible_audio(audio_path) as compatible_audio:
            for part_batch in list(_chunks(vocal_parts, 3)) or [[]]:
                part_ids = {part.id for part in part_batch}
                target_batch = [item for item in targets if item["partId"] in part_ids]
                start = min(
                    (part.start_seconds for part in part_batch),
                    default=recording_start_seconds,
                )
                end = max((part.end_seconds for part in part_batch), default=start)
                duration = max(0.5, end - start)
                with _audio_excerpt(
                    compatible_audio, max(0, start - recording_start_seconds), duration
                ) as user_excerpt, _audio_excerpt(
                    reference_vocal_path, start, duration
                ) as reference_excerpt:
                    batch = self._analyze_secondary_batch(
                        user_excerpt,
                        reference_excerpt,
                        part_batch,
                        target_batch,
                        start,
                    )
                if not batch.recording_usable:
                    return batch
                findings.extend(batch.findings)
        return AcousticFindingBatch(recording_usable=True, findings=findings)

    def _analyze_secondary_batch(
        self,
        audio_path: Path,
        reference_vocal_path: Path,
        vocal_parts: list[VocalPart],
        targets: list[dict],
        recording_start_seconds: float,
    ) -> AcousticFindingBatch:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                batch = self._analyze_secondary_once(
                    audio_path,
                    reference_vocal_path,
                    vocal_parts,
                    targets,
                    recording_start_seconds,
                    use_reference=attempt == 0,
                )
                if batch.recording_usable and (
                    not batch.findings
                    or all(item.result == FindingResult.uncertain for item in batch.findings)
                ):
                    raise RuntimeError(
                        "temporarily unavailable: Gemini returned no conclusive target judgments"
                    )
                return batch
            except Exception as exc:
                last_error = exc
                if attempt == 2 or not _retryable_practice_error(exc):
                    raise
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError("Gemini secondary practice analysis failed") from last_error

    def _analyze_sync(
        self,
        audio_path: Path,
        sentences: list[SongSentence],
        reference_vocal_path: Path | None,
        recording_start_seconds: float = 0,
    ) -> AcousticFindingBatch:
        findings: list[AcousticFinding] = []
        with _gemini_compatible_audio(audio_path) as compatible_audio:
            for sentence_batch in list(_chunks(sentences, 4)) or [[]]:
                start = min(
                    (item.start_seconds for item in sentence_batch),
                    default=recording_start_seconds,
                )
                end = max((item.end_seconds for item in sentence_batch), default=start)
                duration = max(0.5, end - start)
                with _audio_excerpt(
                    compatible_audio, max(0, start - recording_start_seconds), duration
                ) as user_excerpt, _optional_audio_excerpt(
                    reference_vocal_path, start, duration
                ) as reference_excerpt:
                    batch = self._analyze_primary_batch(
                        user_excerpt, sentence_batch, reference_excerpt
                    )
                if not batch.recording_usable:
                    return batch
                findings.extend(batch.findings)
        return AcousticFindingBatch(recording_usable=True, findings=findings)

    def _analyze_primary_batch(
        self,
        audio_path: Path,
        sentences: list[SongSentence],
        reference_vocal_path: Path | None,
    ) -> AcousticFindingBatch:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                batch = self._analyze_once(audio_path, sentences, reference_vocal_path)
                if batch.recording_usable and batch.findings and all(
                    finding.result == FindingResult.uncertain for finding in batch.findings
                ):
                    raise RuntimeError(
                        "temporarily unavailable: Gemini returned no conclusive target judgments"
                    )
                if batch.recording_usable and not batch.findings:
                    raise RuntimeError(
                        "temporarily unavailable: Gemini returned no target judgments"
                    )
                return batch
            except Exception as exc:
                last_error = exc
                if attempt == 2 or not _retryable_practice_error(exc):
                    raise
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError("Gemini practice analysis failed") from last_error

    def _analyze_once(
        self,
        audio_path: Path,
        sentences: list[SongSentence],
        reference_vocal_path: Path | None,
    ) -> AcousticFindingBatch:
        client = self._client()
        uploaded = None
        reference_audio = None
        try:
            uploaded = _upload_and_wait(client, audio_path, "用户录音")
            if reference_vocal_path is not None:
                reference_audio = _upload_and_wait(client, reference_vocal_path, "参考人声")
            audio_inputs = []
            if reference_audio is not None:
                audio_inputs.append(
                    {
                        "type": "audio",
                        "uri": reference_audio.uri,
                        "mime_type": reference_audio.mime_type,
                    }
                )
            audio_inputs.append(
                {
                    "type": "audio",
                    "uri": uploaded.uri,
                    "mime_type": uploaded.mime_type,
                }
            )
            interaction = client.interactions.create(
                store=False,
                model=self.model,
                input=[
                    {"type": "text", "text": _build_prompt(sentences)},
                    *audio_inputs,
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": AcousticFindingBatch.model_json_schema(),
                },
            )
            batch = AcousticFindingBatch.model_validate_json(interaction.output_text)
            known = {hint.id for sentence in sentences for hint in sentence.language_hints}
            findings = _validated_findings(batch.findings, known)
            return batch.model_copy(update={"findings": findings})
        finally:
            for item in (uploaded, reference_audio):
                _delete_uploaded_file(client, item)
            _close_client(client)

    def _analyze_secondary_once(
        self,
        audio_path: Path,
        reference_vocal_path: Path,
        vocal_parts: list[VocalPart],
        targets: list[dict],
        recording_start_seconds: float = 0,
        *,
        use_reference: bool,
    ) -> AcousticFindingBatch:
        client = self._client()
        user_audio = None
        reference_audio = None
        try:
            user_audio = _upload_and_wait(client, audio_path, "用户录音")
            if use_reference:
                reference_audio = _upload_and_wait(client, reference_vocal_path, "参考人声")
            audio_inputs = []
            if reference_audio is not None:
                audio_inputs.append(
                    {
                        "type": "audio",
                        "uri": reference_audio.uri,
                        "mime_type": reference_audio.mime_type,
                    }
                )
            audio_inputs.append(
                {
                    "type": "audio",
                    "uri": user_audio.uri,
                    "mime_type": user_audio.mime_type,
                }
            )
            interaction = client.interactions.create(
                store=False,
                model=self.model,
                input=[
                    {
                        "type": "text",
                        "text": _build_secondary_prompt(
                            vocal_parts,
                            targets,
                            recording_start_seconds=recording_start_seconds,
                            reference_available=reference_audio is not None,
                        ),
                    },
                    *audio_inputs,
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": AcousticFindingBatch.model_json_schema(),
                },
            )
            batch = AcousticFindingBatch.model_validate_json(interaction.output_text)
            known = {item["hintId"] for item in targets}
            findings = _validated_findings(batch.findings, known)
            return batch.model_copy(update={"findings": findings})
        finally:
            for item in (user_audio, reference_audio):
                _delete_uploaded_file(client, item)
            _close_client(client)



def _retryable_practice_error(exc: Exception) -> bool:
    return isinstance(
        exc, (ValidationError, json.JSONDecodeError, TimeoutError, httpx.TransportError),
    ) or _is_retryable_gemini_error(exc)


def _validated_findings(findings: list[AcousticFinding], known: set[str]) -> list[AcousticFinding]:
    filtered = [item for item in findings if item.hint_id in known]
    if len({item.hint_id for item in filtered}) != len(filtered):
        raise RuntimeError("temporarily unavailable: duplicate target judgments")
    return filtered


def _close_client(client) -> None:
    try:
        client.close()
    except Exception:
        pass


def issue_type_for_hint(hint: LanguageHint) -> LanguageIssueType | None:
    phenomenon = hint.phenomenon.lower()
    operations = {item.operation.value for item in hint.transformations}
    symbols = {mark.symbol for mark in hint.marks}
    if (
        "elision" in phenomenon
        or "not_audibly_released" in phenomenon
        or "unreleased" in operations
        or "delete" in operations
        or "×" in symbols
    ):
        return LanguageIssueType.expected_elision_realized
    if "identical" in phenomenon or "merge" in phenomenon or "└─┘" in symbols:
        return LanguageIssueType.identical_consonants_separated
    if "assimilation" in phenomenon or "resegment" in operations or "‿" in symbols:
        return LanguageIssueType.coalescent_assimilation_missing
    return None


def _wait_for_active(client, uploaded, timeout_seconds: float = 60.0):
    """Gemini rejects freshly uploaded files until server-side processing is ACTIVE."""
    deadline = time.monotonic() + timeout_seconds
    current = uploaded
    while time.monotonic() < deadline:
        state = getattr(current, "state", None)
        state_name = str(getattr(state, "name", state) or "").upper()
        if state_name.rsplit(".", 1)[-1] == "ACTIVE":
            return current
        if not state_name or state_name.endswith("INACTIVE"):
            raise RuntimeError("temporarily unavailable: invalid Gemini file state")
        if state_name.endswith("FAILED"):
            error = getattr(current, "error", None)
            detail = f"：{error}" if error else ""
            raise RuntimeError(f"Gemini 音频文件处理失败{detail}")
        time.sleep(1)
        name = getattr(current, "name", None)
        if not name:
            raise RuntimeError("temporarily unavailable: Gemini file missing resource name")
        current = client.files.get(name=name)
    raise TimeoutError("Gemini 音频文件未在 60 秒内准备完成")


def _upload_and_wait(client, audio_path: Path, label: str):
    uploaded = client.files.upload(file=str(audio_path))
    try:
        return _wait_for_active(client, uploaded)
    except Exception as exc:
        _delete_uploaded_file(client, uploaded)
        raise RuntimeError(f"{label}{exc}") from exc


def _delete_uploaded_file(client, uploaded) -> None:
    delete_provider_file(client, uploaded)


@contextmanager
def _gemini_compatible_audio(audio_path: Path) -> Iterator[Path]:
    """Keep the original take, but normalize browser containers for Gemini Files."""
    if audio_path.suffix.lower() in {".mp3", ".wav"}:
        yield audio_path
        return
    with tempfile.TemporaryDirectory(prefix="verseviva-practice-") as directory:
        converted = Path(directory) / "recording.mp3"
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(audio_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "64k",
                str(converted),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0 or not converted.is_file() or converted.stat().st_size == 0:
            detail = result.stderr.strip()[-500:]
            raise RuntimeError(f"浏览器录音转为模型兼容格式失败：{detail}")
        yield converted


@contextmanager
def _audio_excerpt(
    audio_path: Path,
    start_seconds: float,
    duration_seconds: float,
) -> Iterator[Path]:
    """Give Gemini only the relevant time window so repeated lyrics cannot bleed across parts."""
    if not audio_path.is_file():
        yield audio_path
        return
    with tempfile.TemporaryDirectory(prefix="verseviva-practice-clip-") as directory:
        excerpt = Path(directory) / "excerpt.mp3"
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{max(0, start_seconds):.3f}", "-i", str(audio_path),
                "-t", f"{max(0.5, duration_seconds):.3f}",
                "-ac", "1", "-ar", "16000", "-b:a", "64k", str(excerpt),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0 or not excerpt.is_file() or excerpt.stat().st_size == 0:
            detail = result.stderr.strip()[-500:]
            raise RuntimeError(f"练唱音频分段失败：{detail}")
        yield excerpt


@contextmanager
def _optional_audio_excerpt(
    audio_path: Path | None,
    start_seconds: float,
    duration_seconds: float,
) -> Iterator[Path | None]:
    if audio_path is None:
        yield None
        return
    with _audio_excerpt(audio_path, start_seconds, duration_seconds) as excerpt:
        yield excerpt


def _build_prompt(sentences: list[SongSentence]) -> str:
    targets = []
    for sentence in sentences:
        for hint in sentence.language_hints:
            issue_type = issue_type_for_hint(hint)
            if issue_type is None:
                continue
            targets.append(
                {
                    "hintId": hint.id,
                    "sentenceId": sentence.id,
                    "lyrics": sentence.lyrics,
                    "targetWords": target_words_for_hint(sentence, hint),
                    "symbol": "└┘" if hint.marks[0].symbol == "└─┘" else hint.marks[0].symbol,
                    "referenceAction": _reference_action(hint),
                    "referencePhenomenon": hint.phenomenon,
                    "canonicalPronunciation": hint.canonical_pronunciation,
                    "observedPronunciation": hint.observed_pronunciation,
                    "curatedExplanation": next(
                        (
                            detail.explanation
                            for detail in hint.details
                            if detail.locale == "zh-CN"
                        ),
                        hint.details[0].explanation if hint.details else None,
                    ),
                    "expectedIssueTypeWhenUserDiffers": issue_type.value,
                    "transformations": [
                        item.model_dump(mode="json", by_alias=True)
                        for item in hint.transformations
                    ],
                }
            )
    return f"""
你会依次收到参考整体人声（若提供）和用户录音。参考人声仅用于核对本次原唱的实际处理，
用户录音才是诊断对象；不得把不同 Vocal lane 的声音或歌词互相连接。
你正在核查一段用户练唱录音，只判断 TARGETS 中已有的语言演唱目标。

三类符号必须按以下含义判断：
- ×（吞音/未清楚释放）：参考唱法中目标尾音没有独立、清楚地发出或释放。若用户额外清楚发出该音，
  返回 issue_detected；用户也按参考处理则返回 reference_matched。
- ‿（改音式连读）：相邻词跨边界连续衔接，并按 TARGET 的 observedPronunciation、transformations
  或参考音频发生相应声音变化。用户逐词断开或没有实现该变化时返回 issue_detected。
- └┘（二合一）：边界两侧的输入音共享或融合成一个发音动作。用户把两个音分别完整发出时返回
  issue_detected；合成一个动作则返回 reference_matched。

规则：
- 不评价音高、音色、情绪，也不输出 timing_deviation 或任何毫秒级偏差。
- 不得根据歌词拼写猜测用户唱法；只写录音中可听见的证据。
- 必须为每个 TARGET 恰好返回一次，使用 issue_detected、reference_matched 或 uncertain；
  不得添加 TARGETS 之外的问题。
- issue_detected：用户没有实现参考目标，issueType 必须等于目标给定值。
- reference_matched：用户已实现参考目标，issueType 必须为 null。
- uncertain：伴奏泄漏、叠唱、噪声、漏唱或发音不清导致不能可靠判断，issueType 必须为 null。
- 若整段录音无法可靠判断，recordingUsable=false，并填写 insufficientReason。
- audibleEvidence 使用简短中文，只描述听到的声音；不得声称观察到舌位、频谱或波形。

TARGETS:
{json.dumps(targets, ensure_ascii=False)}
""".strip()


def target_words_for_hint(sentence: SongSentence, hint: LanguageHint) -> str:
    text = sentence.pronunciation.text if sentence.pronunciation else sentence.lyrics
    words = list(re.finditer(r"[A-Za-z]+(?:['’][A-Za-z]+)*", text))
    position = hint.marks[0].start_char_index
    left = next((word.group() for word in reversed(words) if word.start() <= position), "")
    if hint.marks[0].symbol == "×":
        return left
    right = next((word.group() for word in words if word.start() > position), "")
    return " ".join(item for item in (left, right) if item)


def _reference_action(hint: LanguageHint) -> str:
    symbol = hint.marks[0].symbol
    if symbol == "×":
        return "目标尾音在参考唱法中不独立、清楚地发出或释放"
    if symbol == "‿":
        return "相邻词连续衔接，并按参考音频或 observedPronunciation 发生改音"
    return "边界两侧输入音共享或融合为一个发音动作"


def secondary_target_id(part_id: str, hint_id: str) -> str:
    return f"secondary:{part_id}:{hint_id}"


def _build_secondary_prompt(
    vocal_parts: list[VocalPart],
    targets: list[dict],
    *,
    recording_start_seconds: float = 0,
    reference_available: bool = True,
) -> str:
    audio_description = (
        "包含多层人声的参考 vocals stem 和用户录音"
        if reference_available
        else "用户单独录制的次轨；本次不提供混合参考音"
    )
    parts = [
        {
            "partId": part.id,
            "role": part.role.value,
            "lyrics": part.lyrics,
            "referenceStartSeconds": part.start_seconds,
            "referenceEndSeconds": part.end_seconds,
            "userAudioStartSeconds": max(0, part.start_seconds - recording_start_seconds),
            "userAudioEndSeconds": max(0, part.end_seconds - recording_start_seconds),
        }
        for part in vocal_parts
    ]
    return f"""
你会收到{audio_description}。
以下 secondary 歌词和时间锚点来自已确认的歌词编排，是不可推翻的输入事实。只比较这些歌词的
语言演唱动作与用户录音，不评价音高、音色、
情绪，不输出 timing_deviation 或毫秒偏差。
三类核查含义：expected_elision_realized 检查用户是否把参考中吞掉或未释放的尾音额外清楚发出；
coalescent_assimilation_missing 检查用户是否漏掉 ‿ 所表示的改音式连续衔接；
identical_consonants_separated 检查用户是否把 └┘ 所表示的二合一动作拆成两个音。

确定的次轨编排：{json.dumps(parts, ensure_ascii=False)}
只允许核查以下由 Song Profile 已确认标记生成的 TARGETS：
{json.dumps(targets, ensure_ascii=False)}

约束：
- 参考 stem 含主唱和其他重叠人声，只用于辅助听发音；不得因为某几个词被主唱遮盖、无法分离，
  就否定确定歌词、声称歌词不在区间或返回 recordingUsable=false。单项目听不清应返回 uncertain。
- recordingUsable=false 只用于用户录音本身没有可辨认演唱、严重损坏或全部被噪声覆盖。
- 当参考 stem 的目标动作听不清时，直接按照 TARGETS 中的 symbol、referenceAction、标准/实际读音
  检查用户录音是否完成目标；不得据此否定 TARGET。没有具体 TARGET 的歌词不得自行补充判断。
- 如果本次没有参考音，这是混合参考无法可靠分离后的 Plan B；必须直接依据确定 TARGETS 核查用户录音，
  不得仅以“缺少参考音”为由把全部项目返回 uncertain。
- 用户录音从所选第一条次轨开始，后续每条次轨按各自 referenceStartSeconds 相对排列；不得只核查
  第一条，也不得把某条次轨错配到另一条的参考区间。
- 每条编排的 userAudioStartSeconds/userAudioEndSeconds 是它在用户录音中的核查区间；重复歌词也必须
  按 partId 和这个区间逐条判断，禁止把另一遍的正确发音复制为当前遍结论。
- issue_detected 只用于参考和用户之间清楚可听的语言动作差异，issueType 必须匹配 hintId。
- reference_matched 表示该类差异没有出现；uncertain 表示单项无法判断。
- 必须为每个 TARGET 恰好返回一次，才能与该次轨近期练习进行同目标比较。
- 最多返回 3 个 issue_detected；问题不足时不得凑数。
- audibleEvidence 只用简短中文描述实际听感，不得编造频谱、舌位或波形证据。
""".strip()


def _chunks(items: list, size: int) -> Iterator[list]:
    for index in range(0, len(items), size):
        yield items[index:index + size]
