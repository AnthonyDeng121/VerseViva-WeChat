from tests.test_wechat_auth import (  # noqa: F401
    auth_client,
    bearer,
    create_song,
    login,
    upload_take,
)


def test_private_reference_and_recording_download_support_range_with_auth(auth_client):  # noqa: F811
    client, data_dir = auth_client
    alice, bob = login(client), login(client, "bob")
    a, b = bearer(alice), bearer(bob)
    job = create_song(client, a, data_dir)
    take = upload_take(client, job["song_id"], a).json()
    for path in [f"/api/v1/songs/{job['song_id']}/audio/source", take["audioUrl"]]:
        response = client.get(path, headers={**a, "Range": "bytes=0-3"})
        assert response.status_code == 206
        assert len(response.content) == 4
        assert "no-store" in response.headers["cache-control"]
        assert "Authorization" in response.headers["vary"]
        assert response.headers["x-content-type-options"] == "nosniff"
        assert client.get(path, headers=b).status_code == 404
        assert client.get(path).status_code == 404
        assert client.get(path + "?token=" + alice["accessToken"]).status_code == 404
    assert client.get(f"/data/takes/{take['takeId']}/{take['storedFilename']}").status_code == 404
