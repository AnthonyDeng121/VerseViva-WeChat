"""Check recorded release evidence; never infer legal permission from cached files."""

import argparse
import json
from pathlib import Path

from server.services.song_access import PUBLIC_HERO_SONG_IDS

SCOPES = {"audio_distribution", "lyrics_display", "derived_audio", "model_processing"}
REVIEWS = {"privacy_contract", "recording_consent", "ai_disclosure", "processor_regions",
           "provider_terms_and_audience", "deletion_and_backups", "wechat_platform_setup"}


def filled(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def audit(review: dict, *, glm_enabled: bool = False) -> list[str]:
    blockers = []
    if review.get("schemaVersion") != 1:
        blockers.append("review_schema")
    checks = review.get("checks", {})
    for key in sorted(REVIEWS):
        item = checks.get(key, {})
        if (item.get("status") != "reviewed" or not filled(item.get("evidence"))
                or not filled(item.get("reviewedAt"))):
            blockers.append("review:" + key)
    providers = review.get("providers", {})
    for name in ["gemini"] + (["glm"] if glm_enabled else []):
        item = providers.get(name, {})
        region = item.get("processingRegion")
        if (item.get("status") != "reviewed" or not filled(region)
                or region.strip().lower() in {"unknown", "unverified", "待确认"}
                or not filled(item.get("evidence"))):
            blockers.append("provider:" + name)
    assets = review.get("assets", [])
    if not isinstance(assets, list):
        return blockers + ["asset_schema"]
    ids = [item.get("songId") for item in assets]
    if len(ids) != len(set(ids)):
        blockers.append("duplicate_assets")
    for song in sorted(PUBLIC_HERO_SONG_IDS):
        matches = [item for item in assets if item.get("songId") == song]
        item = matches[0] if len(matches) == 1 else {}
        if (item.get("status") != "authorized" or not SCOPES <= set(item.get("scopes", []))
                or not filled(item.get("evidence"))
                or not filled(item.get("reviewedAt"))):
            blockers.append("asset:" + song)
    return blockers


def require_review(path: Path, *, glm_enabled: bool = False) -> None:
    try:
        blockers = audit(json.loads(path.read_text(encoding="utf-8")), glm_enabled=glm_enabled)
    except (OSError, ValueError, TypeError, AttributeError):
        raise RuntimeError("Release review is missing or invalid") from None
    if blockers:
        raise RuntimeError("Release evidence incomplete: " + ", ".join(blockers))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--glm-enabled", action="store_true")
    args = parser.parse_args()
    try:
        require_review(args.review, glm_enabled=args.glm_enabled)
    except RuntimeError as exc:
        print(json.dumps({"recordedEvidenceComplete": False, "reason": str(exc)}))
        raise SystemExit(1) from None
    print(json.dumps({"recordedEvidenceComplete": True, "legalComplianceCertified": False}))


if __name__ == "__main__":
    main()
