import asyncio
import math
import re
import subprocess
from pathlib import Path
from uuid import uuid4

from server.config import Settings
from server.models.practice import (
    AttemptComparison,
    ComparisonResult,
    LanguageIssue,
    LanguageIssueType,
    PracticeAttempt,
    PracticeStatus,
    TargetEvaluation,
    TargetResult,
)
from server.models.recording import RecordingTake
from server.models.song import SongProfile, SongSentence, VocalPart
from server.services.model_errors import public_model_failure_message
from server.services.practice.analyzer import (
    GeminiPracticeAnalyzer,
    issue_type_for_hint,
    secondary_target_id,
    target_words_for_hint,
)
from server.services.practice.coach import GlmPracticeCoach
from server.services.practice.models import AcousticFinding, FindingResult
from server.storage.practice_store import PracticeStore

PRACTICE_ANALYSIS_VERSION = "practice-language-v7"


def failed_practice_attempt(
    settings: Settings, take: RecordingTake, error: Exception,
) -> PracticeAttempt:
    return PracticeAttempt(
        attempt_id=f"attempt_{uuid4().hex}", take_id=take.take_id,
        session_id=take.session_id, song_id=take.song_id, track_slot_id=take.track_slot_id,
        sentence_ids=take.sentence_ids, status=PracticeStatus.failed,
        comparison=AttemptComparison(result=ComparisonResult.insufficient_data),
        insufficient_reason=public_model_failure_message(error),
        acoustic_provider=settings.practice_acoustic_provider, acoustic_model=settings.gemini_model,
        coaching_provider="glm" if settings.glm_api_key else "template_fallback",
        coaching_model=settings.glm_model if settings.glm_api_key else "rules-v1",
        analysis_version=PRACTICE_ANALYSIS_VERSION,
    )


async def analyze_practice_take(
    settings: Settings,
    take: RecordingTake,
    profile: SongProfile,
    audio_path: Path,
) -> PracticeAttempt:
    store = PracticeStore(settings.data_dir)
    existing = store.get_for_take(take.take_id)
    if (
        existing is not None
        and existing.status == PracticeStatus.analyzed
        and existing.analysis_version == PRACTICE_ANALYSIS_VERSION
    ):
        return existing

    sentences = [item for item in profile.sentences if item.id in take.sentence_ids]
    is_secondary = take.track_slot_id.startswith("secondary:")
    if not is_secondary:
        sentences = [_primary_only_sentence(item) for item in sentences]
    targets = [
        hint
        for sentence in sentences
        for hint in sentence.language_hints
        if issue_type_for_hint(hint) is not None
    ]
    base = {
        "attempt_id": f"attempt_{uuid4().hex}",
        "take_id": take.take_id,
        "session_id": take.session_id,
        "song_id": take.song_id,
        "track_slot_id": take.track_slot_id,
        "sentence_ids": take.sentence_ids,
        "analysis_version": PRACTICE_ANALYSIS_VERSION,
        "acoustic_provider": settings.practice_acoustic_provider,
        "acoustic_model": settings.gemini_model,
        "coaching_provider": "glm" if settings.glm_api_key else "template_fallback",
        "coaching_model": settings.glm_model if settings.glm_api_key else "rules-v1",
    }
    history = _comparable_history(store, take)

    secondary_parts = [
        item
        for item in profile.vocal_parts
        if item.lane.value == "secondary"
        and (take.vocal_part_id is None or item.id == take.vocal_part_id)
        and item.start_seconds < take.selection_end_seconds
        and item.end_seconds > take.selection_start_seconds
        and (not item.sentence_ids or bool(set(item.sentence_ids) & set(take.sentence_ids)))
    ]
    if is_secondary and not secondary_parts:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.insufficient_data,
            comparison=_comparison(history, []),
            insufficient_reason="所选范围没有可绑定的次轨歌词，无法进行可靠语言诊断。",
        )
        store.save(attempt)
        return attempt
    secondary_targets = (
        _secondary_target_specs(secondary_parts, sentences) if is_secondary else []
    )
    if is_secondary and not secondary_targets:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.insufficient_data,
            comparison=_comparison(history, []),
            insufficient_reason="所选次轨歌词还没有已确认的吞音、改音或二合一标记。",
        )
        store.save(attempt)
        return attempt
    if not is_secondary and not targets:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.insufficient_data,
            comparison=_comparison(history, []),
            insufficient_reason="所选句子还没有可核查的语言标注目标。",
        )
        store.save(attempt)
        return attempt
    if (settings.practice_acoustic_provider != "gemini" or settings.gemini_api_key is None
            or not settings.gemini_api_key.get_secret_value().strip()):
        attempt = failed_practice_attempt(
            settings, take, RuntimeError("Practice model unavailable"),
        )
        store.save(attempt)
        return attempt

    try:
        audible = await asyncio.to_thread(
            _has_audible_signal, settings.ffmpeg_executable, audio_path,
        )
    except Exception as exc:
        attempt = failed_practice_attempt(settings, take, exc)
        store.save(attempt)
        return attempt
    if not audible:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.insufficient_data,
            comparison=_comparison(history, []),
            insufficient_reason="录音中没有检测到可辨认的人声信号，本次不计入练唱记忆。",
        )
        store.save(attempt)
        return attempt

    analyzer = GeminiPracticeAnalyzer(
        settings.gemini_api_key.get_secret_value(),
        settings.gemini_model,
        request_timeout_seconds=settings.practice_request_timeout_seconds,
    )
    try:
        if is_secondary and secondary_parts:
            reference_vocal_path = (
                settings.data_dir / "songs" / profile.song_id / "audio" / "vocals.mp3"
            )
            if not reference_vocal_path.is_file():
                reference_vocal_path = reference_vocal_path.with_suffix(".wav")
            if not reference_vocal_path.is_file():
                raise FileNotFoundError("参考整体人声资产不存在")
            batch = await analyzer.analyze_secondary(
                audio_path,
                reference_vocal_path,
                secondary_parts,
                secondary_targets,
                take.selection_start_seconds,
            )
        else:
            reference_vocal_path = (
                settings.data_dir / "songs" / profile.song_id / "audio" / "vocals.mp3"
            )
            if not reference_vocal_path.is_file():
                reference_vocal_path = reference_vocal_path.with_suffix(".wav")
            batch = await analyzer.analyze(
                audio_path,
                sentences,
                reference_vocal_path if reference_vocal_path.is_file() else None,
                take.selection_start_seconds,
            )
    except Exception as exc:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.failed,
            comparison=AttemptComparison(result=ComparisonResult.insufficient_data),
            insufficient_reason=public_model_failure_message(exc),
        )
        store.save(attempt)
        return attempt

    if not batch.recording_usable:
        attempt = PracticeAttempt(
            **base,
            status=PracticeStatus.insufficient_data,
            comparison=_comparison(history, []),
            insufficient_reason=batch.insufficient_reason or "本次录音不足以可靠判断。",
        )
        store.save(attempt)
        return attempt

    # A usable singing take must contain at least one audible target judgement.
    # Empty findings previously fell through to "no issues" and were incorrectly
    # presented as a successful attempt, including for silent recordings.
    if not _has_audible_judgment(batch.findings):
        attempt = failed_practice_attempt(settings, take, RuntimeError("No target judgments"))
        store.save(attempt)
        return attempt

    issues = (
        _build_secondary_issues(
            secondary_parts,
            secondary_targets,
            batch.findings,
            take.sentence_ids,
            settings.practice_issue_confidence_threshold,
        )
        if is_secondary and secondary_parts
        else _build_issues(
            sentences,
            batch.findings,
            settings.practice_issue_confidence_threshold,
        )
    )
    target_types = (
        {
            item["hintId"]: LanguageIssueType(item["issueType"])
            for item in secondary_targets
        }
        if is_secondary and secondary_parts
        else {
            hint.id: issue_type_for_hint(hint)
            for sentence in sentences
            for hint in sentence.language_hints
            if issue_type_for_hint(hint) is not None
        }
    )
    evaluations = _build_target_evaluations(
        batch.findings, target_types, settings.practice_issue_confidence_threshold,
    )
    if not evaluations:
        attempt = PracticeAttempt(
            **base, status=PracticeStatus.insufficient_data,
            comparison=AttemptComparison(result=ComparisonResult.insufficient_data),
            insufficient_reason="本次录音不足以可靠判断。",
        )
        store.save(attempt)
        return attempt
    comparison = _comparison(history, evaluations)
    target_ids_by_sentence = {
        sentence.id: {
            hint.id
            for hint in sentence.language_hints
            if issue_type_for_hint(hint) is not None
        }
        for sentence in sentences
    }
    if is_secondary and secondary_parts:
        target_ids_by_sentence = {
            sentence_id: {
                item["hintId"]
                for item in secondary_targets
                if sentence_id == item["sentenceId"]
            }
            for sentence_id in take.sentence_ids
        }
    sentence_comparisons = {
        sentence_id: _comparison(
            [item for item in history if sentence_id in item.sentence_ids],
            [item for item in evaluations if item.target_id in target_ids],
        )
        for sentence_id, target_ids in target_ids_by_sentence.items()
        if target_ids and any(item.target_id in target_ids for item in evaluations)
    }
    coach = GlmPracticeCoach(
        settings.glm_api_key.get_secret_value() if settings.glm_api_key else None,
        settings.glm_model,
        settings.glm_base_url,
        settings.glm_timeout_seconds,
    )
    recommendations = await coach.recommend(issues, store.memory(take.session_id))
    attempt = PracticeAttempt(
        **base,
        status=PracticeStatus.analyzed,
        issues=issues,
        target_evaluations=evaluations,
        recommendations=recommendations,
        comparison=comparison,
        sentence_comparisons=sentence_comparisons,
    )
    store.save(attempt)
    return attempt


def _has_audible_judgment(findings: list[AcousticFinding]) -> bool:
    return any(item.result != FindingResult.uncertain for item in findings)


def _has_audible_signal(ffmpeg_executable: str, audio_path: Path) -> bool:
    """Reject near-digital-silence before an LLM can hallucinate a pronunciation."""
    result = subprocess.run(
        [
            ffmpeg_executable,
            "-hide_banner",
            "-i",
            str(audio_path),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "NUL" if __import__("os").name == "nt" else "/dev/null",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Recording signal probe failed")
    match = re.search(r"max_volume:\s*(-?(?:[\d.]+|inf))\s*dB", result.stderr, re.IGNORECASE)
    if match is None:
        raise RuntimeError("Recording signal probe returned no peak evidence")
    peak = float(match.group(1))
    if peak == float("-inf"):
        return False
    if not math.isfinite(peak):
        raise RuntimeError("Recording signal probe returned invalid peak evidence")
    return peak > -45.0


def _primary_only_sentence(sentence: SongSentence) -> SongSentence:
    parenthetical_ranges = [match.span() for match in re.finditer(r"\([^)]*\)", sentence.lyrics)]
    hints = [
        hint
        for hint in sentence.language_hints
        if not any(
            start <= mark.start_char_index < end
            for mark in hint.marks
            for start, end in parenthetical_ranges
        )
    ]
    lyrics = re.sub(r"\s*\([^)]*\)", "", sentence.lyrics).strip()
    return sentence.model_copy(update={"lyrics": lyrics, "language_hints": hints})


def _secondary_target_specs(
    vocal_parts: list[VocalPart],
    sentences: list[SongSentence],
) -> list[dict]:
    sentence_map = {item.id: item for item in sentences}
    specs = []
    for part in vocal_parts:
        for sentence_id in part.sentence_ids:
            sentence = sentence_map.get(sentence_id)
            if sentence is None:
                continue
            ranges = [match.span() for match in re.finditer(r"\([^)]*\)", sentence.lyrics)]
            whole_secondary = sentence.lyrics.strip().startswith("(")
            for hint in sentence.language_hints:
                issue_type = issue_type_for_hint(hint)
                if issue_type is None:
                    continue
                position = hint.marks[0].start_char_index
                belongs_to_secondary = whole_secondary or any(
                    start <= position < end for start, end in ranges
                )
                if not belongs_to_secondary:
                    continue
                detail = next(
                    (item for item in hint.details if item.locale == "zh-CN"),
                    hint.details[0] if hint.details else None,
                )
                specs.append(
                    {
                        "hintId": secondary_target_id(part.id, hint.id),
                        "sourceHintId": hint.id,
                        "partId": part.id,
                        "sentenceId": sentence_id,
                        "lyrics": part.lyrics,
                        "targetWords": target_words_for_hint(sentence, hint) or part.lyrics,
                        "symbol": hint.marks[0].symbol,
                        "issueType": issue_type.value,
                        "referenceAction": (
                            detail.explanation if detail else hint.phenomenon
                        ),
                        "canonicalPronunciation": hint.canonical_pronunciation,
                        "observedPronunciation": hint.observed_pronunciation,
                        "transformations": [
                            item.model_dump(mode="json", by_alias=True)
                            for item in hint.transformations
                        ],
                    }
                )
    return specs


def _build_issues(
    sentences: list[SongSentence],
    findings: list,
    threshold: float,
) -> list[LanguageIssue]:
    target_map = {
        hint.id: (sentence, hint)
        for sentence in sentences
        for hint in sentence.language_hints
        if issue_type_for_hint(hint) is not None
    }
    issues = []
    for finding in findings:
        target = target_map.get(finding.hint_id)
        if (
            target is None
            or finding.result != FindingResult.issue_detected
            or finding.confidence < threshold
        ):
            continue
        sentence, hint = target
        expected_type = issue_type_for_hint(hint)
        if expected_type is None or finding.issue_type != expected_type:
            continue
        segments = [
            segment
            for transformation in hint.transformations
            for segment in transformation.input_segments
        ]
        issues.append(
            LanguageIssue(
                issue_id=f"issue_{uuid4().hex}",
                type=expected_type,
                hint_id=hint.id,
                sentence_id=sentence.id,
                word_text=target_words_for_hint(sentence, hint),
                target_segments=segments,
                confidence=finding.confidence,
                audible_evidence=finding.audible_evidence,
            )
        )
    return sorted(issues, key=lambda item: item.confidence, reverse=True)[:3]


def _comparable_history(store: PracticeStore, take: RecordingTake) -> list[PracticeAttempt]:
    candidates = store.list_for_session(take.session_id, take.song_id)
    comparable = [
        item
        for item in candidates
        if item.take_id != take.take_id
        and item.track_slot_id.split(":", 1)[0] == take.track_slot_id.split(":", 1)[0]
        and bool(set(item.sentence_ids) & set(take.sentence_ids))
        and item.status == PracticeStatus.analyzed
    ]
    return comparable[-5:]


def _build_target_evaluations(
    findings: list[AcousticFinding],
    target_types: dict[str, LanguageIssueType],
    threshold: float = 0.65,
) -> list[TargetEvaluation]:
    evaluations = []
    for finding in findings:
        issue_type = target_types.get(finding.hint_id)
        if (finding.result == FindingResult.uncertain or issue_type is None
            or finding.confidence < threshold
            or (finding.issue_type is not None and finding.issue_type != issue_type)):
            continue
        evaluations.append(
            TargetEvaluation(
                target_id=finding.hint_id,
                issue_type=issue_type,
                result=TargetResult(finding.result.value),
                confidence=finding.confidence,
            )
        )
    return evaluations


def _build_secondary_issues(
    vocal_parts: list[VocalPart],
    targets: list[dict],
    findings: list,
    sentence_ids: list[str],
    threshold: float,
) -> list[LanguageIssue]:
    parts_by_id = {part.id: part for part in vocal_parts}
    target_specs = {item["hintId"]: item for item in targets}
    issues = []
    for finding in findings:
        target = target_specs.get(finding.hint_id)
        vocal_part = parts_by_id.get(target["partId"]) if target else None
        if (
            vocal_part is None
            or
            finding.result != FindingResult.issue_detected
            or finding.issue_type is None
            or finding.confidence < threshold
            or finding.issue_type.value != target["issueType"]
        ):
            continue
        issues.append(
            LanguageIssue(
                issue_id=f"issue_{uuid4().hex}",
                type=finding.issue_type,
                hint_id=finding.hint_id,
                sentence_id=(
                    vocal_part.sentence_ids[0]
                    if vocal_part.sentence_ids
                    else sentence_ids[0]
                ),
                word_text=target["targetWords"],
                target_segments=[],
                confidence=finding.confidence,
                audible_evidence=finding.audible_evidence,
            )
        )
    return sorted(issues, key=lambda item: item.confidence, reverse=True)[:3]


def _comparison(
    history: list[PracticeAttempt],
    current: list[TargetEvaluation],
) -> AttemptComparison:
    if not history:
        return AttemptComparison(result=ComparisonResult.first_attempt)
    previous = history[-1]
    old_types = {item.type for item in previous.issues}
    new_types = {
        item.issue_type for item in current if item.result == TargetResult.issue_detected
    }
    resolved = sorted(old_types - new_types, key=str)
    added = sorted(new_types - old_types, key=str)
    improved_targets = []
    unchanged_targets = []
    regressed_targets = []
    for evaluation in current:
        prior = [
            item
            for attempt in history
            for item in attempt.target_evaluations
            if item.target_id == evaluation.target_id
        ]
        if not prior:
            continue
        issue_weight = sum(
            item.confidence for item in prior if item.result == TargetResult.issue_detected
        )
        matched_weight = sum(
            item.confidence for item in prior if item.result == TargetResult.reference_matched
        )
        prior_result = (
            TargetResult.issue_detected
            if issue_weight >= matched_weight
            else TargetResult.reference_matched
        )
        if (
            prior_result == TargetResult.issue_detected
            and evaluation.result == TargetResult.reference_matched
        ):
            improved_targets.append(evaluation.target_id)
        elif (
            prior_result == TargetResult.reference_matched
            and evaluation.result == TargetResult.issue_detected
        ):
            regressed_targets.append(evaluation.target_id)
        else:
            unchanged_targets.append(evaluation.target_id)
    if not improved_targets and not regressed_targets and not unchanged_targets:
        result = ComparisonResult.first_attempt
    elif improved_targets and not regressed_targets:
        result = ComparisonResult.improved
    elif regressed_targets and not improved_targets:
        result = ComparisonResult.regressed
    else:
        result = ComparisonResult.unchanged
    return AttemptComparison(
        previous_attempt_id=previous.attempt_id,
        result=result,
        resolved_issue_types=resolved,
        new_issue_types=added,
        lookback_attempt_count=len(history),
        improved_target_ids=improved_targets,
        unchanged_target_ids=unchanged_targets,
        regressed_target_ids=regressed_targets,
    )
