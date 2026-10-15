"""Technical disclosure facts, not a substitute for a published privacy contract."""

from server.config import Settings


def processing_facts(settings: Settings) -> dict:
    providers = []
    if (settings.practice_acoustic_provider == "gemini"
            or settings.language_analysis_provider == "gemini"):
        providers.append({"name": "Google Gemini API", "data": ["audio", "lyrics", "targets"],
                          "processingRegion": "unverified",
                          "fileDeletion": "best_effort_after_request",
                          "billingAndRetentionTerms": "requires_operator_review"})
    if settings.glm_api_key:
        providers.append({"name": "GLM-compatible coaching endpoint",
                          "data": ["structured_issues", "aggregate_practice_trends"],
                          "processingRegion": "unverified", "rawAudioSent": False})
    return {
        "schemaVersion": "privacy-facts-v1",
        "isPublishedPrivacyContract": False,
        "providers": providers,
        "identity": {"wechat": "appid_scoped_openid_digest_and_random_owner",
                     "businessToken": "server_stores_digest_client_memory_only"},
        "recording": {"beforeUpload": "client_temporary_file",
                      "analyzeOnly": "temporary_server_upload_then_client_requests_deletion",
                      "analyzeOnlyFeedback": "retained_for_memory_until_deleted",
                      "saved": "retained_until_user_deletes_no_automatic_expiry",
                      "interruptedCleanup": "may_require_retry_or_orphan_maintenance"},
        "aiFeedback": {"generated": True, "humanReviewRequired": True,
                       "notPitchScoring": True},
        "deletion": {"savedTake": "DELETE /api/v1/takes/{takeId}",
                     "retainedFeedback": "DELETE /api/v1/practice/attempts/{attemptId}",
                     "thirdPartyImmediateDeletionGuaranteed": False,
                     "backupImmediateDeletionGuaranteed": False},
        "releaseStatus": "operator_privacy_region_and_material_review_required",
    }
