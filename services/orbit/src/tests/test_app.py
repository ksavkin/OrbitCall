import os

os.environ.setdefault("ORBIT_SERVICE_TOKEN", "test-token")
from fastapi.testclient import TestClient  # noqa: E402

from orbit import app as appmod  # noqa: E402

client = TestClient(appmod.app)
H = {"X-Service-Token": appmod.TOKEN}


def test_health_needs_no_token_and_the_rest_do():
    assert client.get("/health").json()["ok"]
    r = client.get("/snapshot")
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    assert client.get("/snapshot", headers=H).json()["objectCount"] > 18000


def test_errors_use_the_spec_codes(pair):
    assert client.post("/candidates", json={**pair, "objectA": "999999999"}, headers=H).json()["error"]["code"] == "NOT_FOUND"
    assert client.post("/candidates", json={"objectA": "25544"}, headers=H).json()["error"]["code"] == "VALIDATION"
    assert client.post("/verify", json={"objectId": "25544"}, headers=H).status_code == 400
    assert client.post("/screen", json={}, headers=H).json()["error"]["code"] == "VALIDATION"
    stale = client.post("/screen", json={"snapshotId": "old", "primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z"}, headers=H)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "SNAPSHOT_MISMATCH"
    assert client.get("/objects/31021", headers=H).json()["kind"] == "debris"
    assert client.get("/objects/999999999", headers=H).json()["error"]["code"] == "NOT_FOUND"
    assert client.post("/objects", json={"objectIds": ["25544", "x"]}, headers=H).json()["missing"] == ["x"]
    assert client.get("/validation", params={"snapshotId": "old"}, headers=H).status_code == 409


def test_candidates_and_replay_over_http(pair):
    out = client.post("/candidates", json=pair, headers=H).json()
    assert len(out["candidates"]) == 48
    v = client.post("/verify", headers=H, json={"objectId": "25544", "replay": "iss-simulated-reboost",
                                                 "expected": {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}}).json()
    assert v["result"] == "consistent" and v["simulated"] is True
