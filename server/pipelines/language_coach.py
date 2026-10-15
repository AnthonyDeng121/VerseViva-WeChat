import asyncio
import json
import time
from pathlib import Path

from server.models.song import SongSentence
from server.services.language.models import LanguageCandidate, LanguageObservationBatch
from server.services.provider_files import delete_provider_file


class DisabledLanguageCoach:
    provider = "disabled"
    model = "disabled"

    async def analyze(
        self,
        vocal_audio: Path,
        lyrics: str,
        sentences: list[SongSentence],
        candidates: list[LanguageCandidate],
    ) -> LanguageObservationBatch:
        return LanguageObservationBatch(lyrics_match="not_analyzed", observations=[])


class GeminiLanguageCoach:
    provider = "gemini"

    def __init__(self, api_key: str, model: str = "gemini-3.8-flash") -> None:
        if not api_key:
            raise ValueError("Gemini API key is required when language analysis is enabled")
        self.api_key = api_key
        self.model = model

    async def analyze(
        self,
        vocal_audio: Path,
        lyrics: str,
        sentences: list[SongSentence],
        candidates: list[LanguageCandidate],
    ) -> LanguageObservationBatch:
        return await asyncio.to_thread(
            self._analyze_sync,
            vocal_audio,
            lyrics,
            sentences,
            candidates,
        )

    def _analyze_sync(
        self,
        vocal_audio: Path,
        lyrics: str,
        sentences: list[SongSentence],
        candidates: list[LanguageCandidate],
    ) -> LanguageObservationBatch:
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                return self._analyze_once(vocal_audio, lyrics, sentences, candidates)
            except Exception as exc:
                last_error = exc
                if attempt == 3 or not _is_retryable_gemini_error(exc):
                    raise
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError("Gemini analysis failed without an error") from last_error

    def _analyze_once(
        self,
        vocal_audio: Path,
        lyrics: str,
        sentences: list[SongSentence],
        candidates: list[LanguageCandidate],
    ) -> LanguageObservationBatch:
        try:
            from google import genai
        except ImportError as exc:
            raise RuntimeError(
                "Gemini language analysis requires the google-genai package"
            ) from exc

        client = genai.Client(api_key=self.api_key)
        uploaded = client.files.upload(file=str(vocal_audio))
        try:
            interaction = client.interactions.create(
                store=False,
                model=self.model,
                input=[
                    {"type": "text", "text": _build_prompt(lyrics, sentences, candidates)},
                    {
                        "type": "audio",
                        "uri": uploaded.uri,
                        "mime_type": uploaded.mime_type,
                    },
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": LanguageObservationBatch.model_json_schema(),
                },
            )
            batch = LanguageObservationBatch.model_validate_json(interaction.output_text)
            known_ids = {candidate.id for candidate in candidates}
            filtered = [
                observation
                for observation in batch.observations
                if observation.candidate_id in known_ids
            ]
            return batch.model_copy(update={"observations": filtered})
        finally:
            delete_provider_file(client, uploaded)


def _is_retryable_gemini_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "429",
            "500",
            "502",
            "503",
            "504",
            "service_unavailable",
            "resource_exhausted",
            "high demand",
            "temporarily unavailable",
            "timeout",
            "audio file processing failed",
            "音频文件处理失败",
        )
    )


def _build_prompt(
    lyrics: str,
    sentences: list[SongSentence],
    candidates: list[LanguageCandidate],
) -> str:
    line_payload = [
        {
            "lineIndex": index,
            "sentenceId": sentence.id,
            "startSeconds": sentence.start_seconds,
            "endSeconds": sentence.end_seconds,
            "lyrics": sentence.lyrics,
        }
        for index, sentence in enumerate(sentences)
    ]
    candidate_payload = [
        candidate.model_dump(mode="json", by_alias=True) for candidate in candidates
    ]
    return f"""
你正在执行 VerseViva 的音频证据核查。歌词和 G2P 只用于定位候选边界，不能作为声音已经发生的证据。

必须逐一核查 CANDIDATES 中的每个 candidateId，并且每个 ID 恰好返回一次。
不得自行添加候选，也不得遗漏候选。即使没有语言现象，也必须返回
continuous_without_change 或 uncertain。漏标不是允许的省略方式。

结果定义：
- clearly_released：目标塞音存在清晰、独立的释放，但没有跨词承接。
- not_audibly_released：没有听到目标辅音的独立释放；不区分删除、未释放或声门化。
- linked_or_resegmented：前词尾音可听地直接承接后词起音或进入后词音节，
  但没有产生新的融合音。辅音到元音的跨词承接优先考虑此项。
- merged_or_assimilated：两个边界音共享一次动作或形成新的音质。必须有区别于普通连续发音的可听证据。
- continuous_without_change：唱得连续，但相对标准音素序列没有可标注的跨词动作变化。
- uncertain：当前音频不能可靠区分。

约束：
- 括号外的 primary 与括号内的 secondary 是分别演唱的不同 Vocal lane；
  禁止将括号前后或主次轨之间的词组成跨词连读、合并、省音或同化证据。
- 没有停顿不自动等于 linked_or_resegmented。
- 但也不能因为没有产生“新音”就漏掉真实的辅音到元音重新切分；
  例如前词尾辅音实际承担后词元音起音时，应返回 linked_or_resegmented。
- rhotic_to_vowel 候选需要检查词尾 r 音是否实际承接后词元音；
  如果可听见这种承接，返回 linked_or_resegmented，而不是因为 ER 被归为元音就忽略。
- consonant_to_glide 候选（例如 If you 的 /f/ + /j/）不得因为“没有产生新音”就判为
  continuous_without_change。若前词辅音的摩擦/发声动作在无重新起音的情况下直接进入 /j/，
  必须返回 linked_or_resegmented。只有听到两个独立起音或边界重置时才返回
  continuous_without_change。
- stop_to_glide 候选（例如 Let you 的 /t/ + /j/）必须执行三选一的听感对比：
  1) 听到一个新的、连续的 /tʃ/ 类破擦段 → merged_or_assimilated；
  2) 听不到词尾 /t/ 的独立实现，而是直接进入 you → not_audibly_released；
  3) /t/ 和 /j/ 都清楚且是两个动作 → continuous_without_change。
  不得只根据拼写或“这是经典音变”选择 merged_or_assimilated。
- 对 targetSpan 包含 If you、let you、want you、did you 等高歧义边界，
  audibleEvidence 必须明确写出实际听到的“连续摩擦/破擦”、“词尾音未出现”或“两次独立起音”；
  无法听清时必须返回 uncertain，不能用语音经验补全。
- 没听见爆破不足以区分删除与未释放，统一使用 not_audibly_released。
- 韩语候选必须以韩文原词和候选中的辅助读音共同定位。罗马音不是声学真值：
  词尾辅音没有独立释放时可返回 not_audibly_released；词尾辅音实际移入后一个
  元音起音时返回 linked_or_resegmented。不得因为罗马字写成 g/k、d/t 就自行判定音变。
- 日语候选必须核查本次演唱中实际可听见的鼻音位置或音段合并。规范假名读法只能
  产生候选，不能单独作为原唱已经发生变化的证据。
- 不得编造波形、频谱、舌位、唇形或声门动作。audibleEvidence 只写当前音频中实际可听见的现象。
- weak 必须 needsHumanReview=true。伴奏、混响、叠唱或分离伪影影响判断时，
  使用 moderate/weak 或 uncertain。
- 不生成 displayMarkup、教学动作、IPA 或候选列表之外的分析。

用户提供歌词：
{lyrics}

对齐后的歌词行：
{json.dumps(line_payload, ensure_ascii=False)}

CANDIDATES：
{json.dumps(candidate_payload, ensure_ascii=False)}
""".strip()
