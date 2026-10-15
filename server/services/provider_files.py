import logging

logger = logging.getLogger(__name__)


def delete_provider_file(client, uploaded) -> None:
    name = getattr(uploaded, "name", None)
    if name:
        try:
            client.files.delete(name=name)
        except Exception:
            # Do not log provider URLs, file IDs, local paths or exception credentials.
            logger.warning("provider_file_delete_failed; provider retention review required")
