import pytest

from server.config import get_settings
from server.services import review_login
from tests.test_wechat_auth import auth_client as auth_client
from tests.test_wechat_auth import bearer, create_song, login

PASSWORD = "test-only-strong-password"
PASSWORD_HASH = review_login.hash_password(PASSWORD)


@pytest.fixture
def reviewer(auth_client, monkeypatch):
    client, data_dir = auth_client
    monkeypatch.setenv("VERSEVIVA_REVIEW_LOGIN_ENABLED", "true")
    monkeypatch.setenv("VERSEVIVA_REVIEW_USERNAME", "reviewer")
    monkeypatch.setenv("VERSEVIVA_REVIEW_PASSWORD_HASH", PASSWORD_HASH)
    monkeypatch.setenv("VERSEVIVA_REVIEW_LOGIN_EXPIRES_AT", "2000000000")
    review_login._attempts.clear()
    get_settings.cache_clear()
    yield client, data_dir
    review_login._attempts.clear()
    get_settings.cache_clear()


def review(client, password=PASSWORD):
    return client.post("/api/v1/auth/review/login",
                       json={"username": "reviewer", "password": password})


def test_review_disabled_by_default(auth_client):
    assert review(auth_client[0]).status_code == 404


def test_review_token_is_stable_isolated_revocable_and_not_wechat(reviewer):
    client, data_dir = reviewer
    normal = login(client)
    response = review(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    account = response.json()
    assert account["ownerId"] != normal["ownerId"]
    assert review(client).json()["ownerId"] == account["ownerId"]
    assert client.get("/api/v1/auth/me", headers=bearer(account)).status_code == 200
    song = create_song(client, bearer(normal), data_dir)
    response = client.get(f"/api/v1/songs/{song['song_id']}", headers=bearer(account))
    assert response.status_code == 404
    assert client.post("/api/v1/auth/logout", headers=bearer(account)).status_code == 204
    assert client.get("/api/v1/auth/me", headers=bearer(account)).status_code == 401


@pytest.mark.parametrize("setting,value", [
    ("VERSEVIVA_REVIEW_LOGIN_ENABLED", "false"),
    ("VERSEVIVA_REVIEW_LOGIN_EXPIRES_AT", "1"),
])
def test_disabling_or_expiry_invalidates_existing_review_tokens(
    reviewer, monkeypatch, setting, value,
):
    client, _ = reviewer
    token = review(client).json()
    monkeypatch.setenv(setting, value)
    get_settings.cache_clear()
    assert review(client).status_code == 404
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401


def test_wrong_password_throttled_without_issuing_token(reviewer):
    client, _ = reviewer
    for _ in range(10):
        assert review(client, "wrong").status_code == 401
    response = review(client)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_password_hash_and_invalid_encoding():
    assert review_login.verify_password(PASSWORD, PASSWORD_HASH)
    assert not review_login.verify_password("wrong", PASSWORD_HASH)
    assert not review_login.verify_password(PASSWORD, "malformed")
