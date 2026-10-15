import json

import httpx

from server.models.practice import LanguageIssue, PracticeMemory, PracticeRecommendation
from server.services.practice.models import CoachingDraftBatch


class GlmPracticeCoach:
    provider = "glm"

    def __init__(self, api_key: str | None, model: str, base_url: str, timeout: float) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def recommend(
        self,
        issues: list[LanguageIssue],
        memory: PracticeMemory,
    ) -> list[PracticeRecommendation]:
        if not issues:
            return []
        if not self.api_key:
            return fallback_recommendations(issues)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "messages": [
                            {"role": "system", "content": _SYSTEM_PROMPT},
                            {
                                "role": "user",
                                "content": json.dumps(
                                    {
                                        "issues": [
                                            item.model_dump(mode="json", by_alias=True,
                                                            exclude={"hint_id", "sentence_id"})
                                            for item in issues
                                        ],
                                        "memory": memory.model_dump(
                                            mode="json", by_alias=True,
                                            exclude={
                                                "session_id": True, "updated_at": True,
                                                "phenomena": {
                                                    "__all__": {"last_practiced_at"}},
                                            },
                                        ),
                                    },
                                    ensure_ascii=False,
                                ),
                            },
                        ],
                        "temperature": 0.2,
                        "response_format": {"type": "json_object"},
                    },
                )
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            batch = CoachingDraftBatch.model_validate_json(content)
            known = {issue.issue_id for issue in issues}
            drafts = [item for item in batch.recommendations if item.issue_id in known][:3]
            if not drafts:
                return fallback_recommendations(issues)
            return [
                PracticeRecommendation(rank=index, **draft.model_dump())
                for index, draft in enumerate(drafts, start=1)
            ]
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return fallback_recommendations(issues)


_SYSTEM_PROMPT = """
你是 VerseViva 外语歌曲演唱教练。只解释输入中的结构化声学事实，禁止添加新问题、
音高评价、节奏偏差、毫秒数或分数。按优先级返回 1 至 3 条建议；问题不足时不要凑数。
每条必须引用已有 issueId，observation 区分“听到的事实”和“参考唱法”，action 只给下一遍
能执行的一个口腔或气流动作。结合 memory 调整优先级，但不得声称不存在的进步。
严格输出 CoachingDraftBatch 对应的 JSON 对象。
""".strip()


def fallback_recommendations(issues: list[LanguageIssue]) -> list[PracticeRecommendation]:
    actions = {
        "expected_elision_realized": (
            "下一遍不要单独弹出这个尾音，完成前一个发音动作后直接进入后词。"
        ),
        "identical_consonants_separated": (
            "下一遍把边界两边的相同辅音只做一次，再直接接后面的元音。"
        ),
        "coalescent_assimilation_missing": "下一遍把边界两个音连成一个连续动作，不要逐字重新起音。",
        "target_phoneme_omitted": "下一遍先慢速唱清目标音，再恢复原速。",
    }
    return [
        PracticeRecommendation(
            rank=index,
            issue_id=issue.issue_id,
            headline=f"先改 {issue.word_text}",
            observation="；".join(issue.audible_evidence) or "这处与参考演唱的语言动作不同。",
            action=actions[issue.type.value],
        )
        for index, issue in enumerate(issues[:3], start=1)
    ]
