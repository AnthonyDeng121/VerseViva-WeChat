import asyncio
import logging
import sqlite3

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from server.api.routes import auth as auth_routes
from server.config import Settings, get_settings
from server.main import app
from server.models.practice import (
    AttemptComparison,
    ComparisonResult,
    PracticeAttempt,
    PracticeStatus,
)
from server.models.song import AnalysisStatus
from server.services import wechat_login
from server.storage.job_store import JobStore
from server.storage.practice_store import PracticeStore
from server.storage.profile_store import ProfileStore
from server.storage.wechat_store import WeChatIdentityStore
from tests.test_song_profile_schema import make_profile


@pytest.fixture
def auth_client(tmp_path, monkeypatch):
    monkeypatch.setenv("VERSEVIVA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VERSEVIVA_WECHAT_LOGIN_ENABLED", "true")
    monkeypatch.setenv("VERSEVIVA_WECHAT_APP_ID", "wx_test_app")
    monkeypatch.setenv("VERSEVIVA_WECHAT_APP_SECRET", "unit-test-secret")
    monkeypatch.setenv("VERSEVIVA_AUTO_RUN_ANALYSIS_PIPELINE", "false")
    get_settings.cache_clear()

    async def fake_exchange(settings, code):
        return {"alice": "openid-alice", "alice-again": "openid-alice", "bob": "openid-bob"}[code]

    monkeypatch.setattr(auth_routes, "exchange_code", fake_exchange)
    with TestClient(app) as client:
        yield client, tmp_path
    get_settings.cache_clear()


def login(client, code="alice"):
    response = client.post("/api/v1/auth/wechat/login", json={"code": code})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    return response.json()


def bearer(value):
    return {"Authorization": "Bearer " + value["accessToken"]}


def create_song(client, headers, data_dir):
    response = client.post(
        "/api/v1/songs/analyze",
        headers=headers,
        files={"audio": ("sample.mp3", b"ID3-unit-test", "audio/mpeg")},
        data={"title": "Owned song", "artist": "Test singer"},
    )
    assert response.status_code == 202
    job = response.json()
    ProfileStore(data_dir).save(make_profile().model_copy(update={"song_id": job["song_id"]}))
    audio_dir = data_dir / "songs" / job["song_id"] / "audio"
    audio_dir.mkdir()
    (audio_dir / "source.mp3").write_bytes(b"source-audio")
    (audio_dir / "accompaniment.mp3").write_bytes(b"backing-audio")
    store = JobStore(data_dir)
    stored = store.get(job["job_id"])
    stored.status = AnalysisStatus.completed
    store.save(stored)
    return job


def upload_take(client, song_id, headers):
    return client.post(
        f"/api/v1/songs/{song_id}/takes",
        headers=headers,
        files={"audio": ("wxfile.tmp", b"\x1aE\xdf\xa3audio", "application/octet-stream")},
        data={
            "session_id": "forged-owner",
            "track_slot_id": "primary:range:s:s:1",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "overdub_append",
        },
    )


def test_wechat_identity_stable_token_hashed_and_logout_revokes(auth_client):
    client, data_dir = auth_client
    first, again, other = login(client), login(client, "alice-again"), login(client, "bob")
    assert first["ownerId"] == again["ownerId"] != other["ownerId"]
    assert first["accessToken"] != again["accessToken"]
    assert set(first) == {"ownerId", "accessToken", "expiresAtMs", "tokenType"}
    with sqlite3.connect(data_dir / "verseviva.sqlite3") as connection:
        values = str(connection.execute("SELECT * FROM wechat_identities").fetchall())
        values += str(connection.execute("SELECT * FROM wechat_tokens").fetchall())
    assert "openid-alice" not in values and first["accessToken"] not in values
    assert client.get("/api/v1/auth/me", headers=bearer(first)).json() == {
        "ownerId": first["ownerId"]
    }
    assert client.post("/api/v1/auth/logout", headers=bearer(first)).status_code == 204
    assert client.get("/api/v1/auth/me", headers=bearer(first)).status_code == 401
    assert client.get("/api/v1/auth/me", headers=bearer(again)).status_code == 200


@pytest.mark.parametrize(
    "authorization", ["", "Basic xyz", "Bearer", "Bearer invalid", "Bearer a b"]
)
def test_bad_bearer_never_falls_back_to_valid_web_cookie(auth_client, authorization):
    client, data_dir = auth_client
    job = create_song(client, {}, data_dir)
    assert client.cookies.get("verseviva_session")
    result = client.get(
        f"/api/v1/songs/jobs/{job['job_id']}", headers={"Authorization": authorization}
    )
    assert result.status_code == 401
    assert "set-cookie" not in result.headers
    assert client.get(f"/api/v1/songs/jobs/{job['job_id']}").status_code == 200


def test_bearer_overrides_cookie_without_claiming_old_anonymous_data(auth_client):
    client, data_dir = auth_client
    web_job = create_song(client, {}, data_dir)
    identity = login(client)
    result = client.get("/api/v1/auth/me", headers=bearer(identity))
    assert result.json()["ownerId"] == identity["ownerId"]
    assert "set-cookie" not in result.headers
    assert (
        client.get(f"/api/v1/songs/{web_job['song_id']}", headers=bearer(identity)).status_code
        == 404
    )
    wx_job = create_song(client, bearer(identity), data_dir)
    assert wx_job["session_id"] == identity["ownerId"]
    assert client.get(f"/api/v1/songs/{wx_job['song_id']}").status_code == 404
    assert client.get(f"/api/v1/songs/{web_job['song_id']}").status_code == 200


def test_all_private_resources_remain_isolated_between_wechat_owners(auth_client):
    client, data_dir = auth_client
    alice, bob = login(client), login(client, "bob")
    a, b = bearer(alice), bearer(bob)
    job = create_song(client, a, data_dir)
    song_id = job["song_id"]
    response = upload_take(client, song_id, a)
    assert response.status_code == 201
    take = response.json()
    assert take["sessionId"] == alice["ownerId"]
    tid = take["takeId"]
    attempt = PracticeAttempt(
        attempt_id="attempt_owned",
        take_id=tid,
        session_id=alice["ownerId"],
        song_id=song_id,
        track_slot_id=take["trackSlotId"],
        sentence_ids=["sentence_001"],
        status=PracticeStatus.analyzed,
        comparison=AttemptComparison(result=ComparisonResult.first_attempt),
        acoustic_provider="test",
        acoustic_model="test",
        coaching_provider="test",
        coaching_model="test",
    )
    PracticeStore(data_dir).save(attempt)
    checks = [
        ("GET", f"/api/v1/songs/jobs/{job['job_id']}"),
        ("POST", f"/api/v1/songs/jobs/{job['job_id']}/retry"),
        ("DELETE", f"/api/v1/songs/jobs/{job['job_id']}"),
        ("GET", f"/api/v1/songs/{song_id}"),
        ("GET", f"/api/v1/songs/{song_id}/audio/source"),
        ("POST", f"/api/v1/songs/{song_id}/reanalyze"),
        ("DELETE", f"/api/v1/songs/{song_id}"),
        ("GET", f"/api/v1/songs/{song_id}/takes?session_id={alice['ownerId']}"),
        ("GET", f"/api/v1/songs/{song_id}/attempts?session_id={alice['ownerId']}"),
        ("GET", f"/api/v1/songs/{song_id}/mixdown?session_id={alice['ownerId']}"),
        ("GET", f"/api/v1/takes/{tid}"),
        ("GET", f"/api/v1/takes/{tid}/audio"),
        ("GET", f"/api/v1/takes/{tid}/attempt"),
        ("POST", f"/api/v1/takes/{tid}/analysis-jobs"),
        ("POST", f"/api/v1/takes/{tid}/analyze"),
        ("DELETE", f"/api/v1/takes/{tid}"),
    ]
    for method, path in checks:
        assert client.request(method, path, headers=b).status_code == 404, (method, path)
    assert client.patch(f"/api/v1/takes/{tid}", headers=b, json={"muted": True}).status_code == 404
    assert upload_take(client, song_id, b).status_code == 404
    assert client.get(f"/api/v1/takes/{tid}/audio", headers=a).status_code == 200
    assert (
        client.get(f"/api/v1/takes/{tid}/attempt", headers=a).json()["attemptId"] == "attempt_owned"
    )
    assert (
        client.get(f"/api/v1/practice/memory?session_id={alice['ownerId']}", headers=b).json()[
            "totalAttempts"
        ]
        == 0
    )
    assert (
        client.get("/api/v1/practice/memory?session_id=forged", headers=a).json()["totalAttempts"]
        == 1
    )
    assert client.delete(f"/api/v1/takes/{tid}", headers=a).status_code == 204


def test_hero_is_public_but_each_owners_takes_and_mix_are_private(auth_client, monkeypatch):
    client, data_dir = auth_client
    hero = "song_00000000000000000000000000000003"
    ProfileStore(data_dir).save(make_profile().model_copy(update={"song_id": hero}))
    audio_dir = data_dir / "songs" / hero / "audio"
    audio_dir.mkdir()
    (audio_dir / "accompaniment.mp3").write_bytes(b"reference")
    alice, bob = login(client), login(client, "bob")
    take = upload_take(client, hero, bearer(alice)).json()
    assert client.get(f"/api/v1/songs/{hero}").status_code == 200
    assert client.get(f"/api/v1/songs/{hero}/takes", headers=bearer(bob)).json() == []
    assert (
        client.get(f"/api/v1/takes/{take['takeId']}/audio", headers=bearer(bob)).status_code == 404
    )
    assert (
        client.get(f"/api/v1/songs/{hero}/mixdown?session_id=x", headers=bearer(bob)).status_code
        == 409
    )

    def render(**kwargs):
        kwargs["output"].parent.mkdir(parents=True)
        kwargs["output"].write_bytes(b"unit-test-mix")

    monkeypatch.setattr("server.api.routes.takes.render_mixdown", render)
    assert (
        client.get(f"/api/v1/songs/{hero}/mixdown?session_id=x", headers=bearer(alice)).content
        == b"unit-test-mix"
    )


def test_orphan_profile_cannot_be_claimed_even_by_uploading_take(auth_client):
    client, data_dir = auth_client
    song_id = "song_" + "f" * 32
    ProfileStore(data_dir).save(make_profile().model_copy(update={"song_id": song_id}))
    identity = login(client)
    assert upload_take(client, song_id, bearer(identity)).status_code == 404
    assert client.get(f"/api/v1/songs/{song_id}", headers=bearer(identity)).status_code == 404


def test_clients_cannot_submit_openid_or_owner_claims(auth_client):
    client, _ = auth_client
    for field in ("openid", "session_id", "ownerId", "appid"):
        assert (
            client.post(
                "/api/v1/auth/wechat/login", json={"code": "alice", field: "forged"}
            ).status_code
            == 422
        )


def test_login_disabled_fails_closed(auth_client, monkeypatch):
    client, _ = auth_client
    identity = login(client)
    monkeypatch.setenv("VERSEVIVA_WECHAT_LOGIN_ENABLED", "false")
    get_settings.cache_clear()
    assert client.post("/api/v1/auth/wechat/login", json={"code": "alice"}).status_code == 503
    assert client.get("/api/v1/auth/me", headers=bearer(identity)).status_code == 401


def test_missing_secret_and_token_tampering_fail_closed(auth_client, monkeypatch):
    client, _ = auth_client
    identity = login(client)
    token = identity["accessToken"]
    modified = token[:-1] + ("a" if token[-1] != "a" else "b")
    assert (
        client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + modified}).status_code
        == 401
    )
    monkeypatch.setenv("VERSEVIVA_WECHAT_APP_SECRET", "")
    get_settings.cache_clear()
    assert client.post("/api/v1/auth/wechat/login", json={"code": "alice"}).status_code == 503


def test_expired_business_token_is_rejected_by_middleware(auth_client, monkeypatch):
    client, _ = auth_client
    monkeypatch.setattr("server.storage.wechat_store.now_seconds", lambda: 1000)
    identity = login(client)
    assert client.get("/api/v1/auth/me", headers=bearer(identity)).status_code == 200
    monkeypatch.setattr("server.storage.wechat_store.now_seconds", lambda: 1000 + 7200)
    assert client.get("/api/v1/auth/me", headers=bearer(identity)).status_code == 401


def test_token_expiry_app_scope_and_restart_persistence(tmp_path, monkeypatch):
    monkeypatch.setattr("server.storage.wechat_store.now_seconds", lambda: 1000)
    store = WeChatIdentityStore(tmp_path)
    identity = store.issue("app_a", "openid", 60)
    again = WeChatIdentityStore(tmp_path)
    assert again.resolve(identity["accessToken"], "app_a") == identity["ownerId"]
    assert again.resolve(identity["accessToken"], "app_b") is None
    assert again.issue("app_b", "openid", 60)["ownerId"] != identity["ownerId"]
    monkeypatch.setattr("server.storage.wechat_store.now_seconds", lambda: 1060)
    assert again.resolve(identity["accessToken"], "app_a") is None


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"errcode": 40029, "errmsg": "secret"}, 401),
        ({"errcode": 45011, "errmsg": "secret"}, 429),
        ({"errcode": -1, "errmsg": "secret"}, 502),
        ({"errcode": []}, 502),
        ({"openid": "x"}, 502),
        ([], 502),
    ],
)
def test_code_exchange_provider_failures_are_safe(payload, status, monkeypatch):
    actual_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    monkeypatch.setattr(
        wechat_login.httpx, "AsyncClient", lambda **kw: actual_client(transport=transport, **kw)
    )
    settings = Settings(
        wechat_login_enabled=True, wechat_app_id="appid", wechat_app_secret="secret"
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(wechat_login.exchange_code(settings, "code"))
    assert caught.value.status_code == status
    assert "secret" not in caught.value.detail


def test_exchange_uses_fixed_endpoint_no_redirect_and_no_secret_in_logs(monkeypatch, caplog):
    actual_client = httpx.AsyncClient
    requests = []

    def reply(request):
        requests.append(request)
        return httpx.Response(
            200, json={"openid": "provider-openid", "session_key": "provider-key"}
        )

    transport = httpx.MockTransport(reply)
    monkeypatch.setattr(
        wechat_login.httpx, "AsyncClient", lambda **kw: actual_client(transport=transport, **kw)
    )
    settings = Settings(
        wechat_login_enabled=True, wechat_app_id="appid", wechat_app_secret="secret-value"
    )
    with caplog.at_level(logging.INFO):
        result = asyncio.run(wechat_login.exchange_code(settings, "sensitive-code"))
    assert result == "provider-openid"
    assert str(requests[0].url).startswith(wechat_login.CODE2SESSION_URL + "?")
    assert "secret-value" not in caplog.text and "sensitive-code" not in caplog.text
    assert "provider-key" not in caplog.text


@pytest.mark.parametrize("mode", ["redirect", "timeout", "bad-json"])
def test_exchange_does_not_redirect_retry_or_expose_transport_errors(monkeypatch, mode):
    actual_client = httpx.AsyncClient
    requests = []

    def reply(request):
        requests.append(request)
        if mode == "redirect":
            return httpx.Response(302, headers={"Location": "https://untrusted.example.com/"})
        if mode == "timeout":
            raise httpx.ReadTimeout("secret-with-query", request=request)
        return httpx.Response(200, content=b"not-json-secret")

    transport = httpx.MockTransport(reply)
    monkeypatch.setattr(
        wechat_login.httpx, "AsyncClient", lambda **kw: actual_client(transport=transport, **kw)
    )
    settings = Settings(
        wechat_login_enabled=True, wechat_app_id="appid", wechat_app_secret="secret-value"
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(wechat_login.exchange_code(settings, "code"))
    assert caught.value.status_code == 502
    assert "secret" not in caught.value.detail
    assert len(requests) == 1
