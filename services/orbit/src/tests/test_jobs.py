"""Jobs (roadmap §5): /screen and /rescreen reserve a persisted job; GET /jobs reports it; v1 compatibility."""

import hashlib
import json
import os
import time

os.environ.setdefault("ORBIT_SERVICE_TOKEN", "test-token")
from fastapi.testclient import TestClient  # noqa: E402

from orbit import app as appmod  # noqa: E402
from orbit.jobs import JobStore  # noqa: E402

client = TestClient(appmod.app)
H = {"X-Service-Token": appmod.TOKEN}
SNAP = appmod.catalog.snapshot_id


def wait_job(job_id: str, timeout: float = 120) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}", headers=H).json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.2)
    raise AssertionError(f"job {job_id} did not finish")


def test_screen_is_a_persisted_idempotent_job():
    body = {"scanId": f"t-{time.time_ns()}", "snapshotId": SNAP, "primaryObjectIds": ["25544"],
            "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T09:00:00Z", "runId": "run-7"}
    r = client.post("/screen", json=body, headers=H)
    assert r.status_code == 202 and r.json()["jobId"] == f"screen-{body['scanId']}"
    job_id = r.json()["jobId"]
    assert (appmod.DATA / "jobs" / f"{job_id}.json").exists()  # persisted before the reply
    again = client.post("/screen", json=body, headers=H)
    assert again.status_code == 200 and again.json()["jobId"] == job_id and not again.json()["created"]
    job = wait_job(job_id)
    assert job["status"] == "completed" and job["result"]["snapshotId"] == SNAP and job["result"]["runId"] == "run-7"
    assert job["counters"]["primariesCompleted"] == 1 and job["coverage"] == job["result"]["coverage"]
    assert job["progress"] == 1.0 and "request" not in job
    clash = client.post("/screen", json={**body, "toUtc": "2026-10-24T10:00:00Z"}, headers=H)
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "JOB_CONFLICT"


def test_bad_requests_fail_before_a_job_exists():
    r = client.post("/screen", json={"jobId": "bad-1", "primaryObjectIds": []}, headers=H)
    assert r.status_code == 400 and client.get("/jobs/bad-1", headers=H).status_code == 404
    stale = client.post("/rescreen", headers=H, json={"snapshotId": "old", "objectId": "25544", "maneuver": {}})
    assert stale.status_code == 409


def test_rescreen_job_and_the_v1_synchronous_path():
    m = {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}
    v1 = client.post("/rescreen", headers=H, json={"objectId": "25544", "maneuver": m, "horizonH": 1})
    assert v1.status_code == 200 and "passed" in v1.json()  # current Convex caller: no snapshotId, no jobId
    # The provider's real body (partner + TCA): same verdict as calling the function directly.
    from orbit.rescreen import rescreen as direct
    full = {"objectId": "25544", "partnerObjectId": "48274", "tcaUtc": "2026-10-24T12:30:00Z", "maneuver": m, "horizonH": 1}
    got = client.post("/rescreen", headers=H, json=full).json()
    assert {k: got[k] for k in ("passed", "originalMissAfterKm", "refusalReason")} == \
        {k: v for k, v in direct(appmod.catalog, full).items() if k in ("passed", "originalMissAfterKm", "refusalReason")}
    forced = client.post("/rescreen?wait=1", headers=H, json={"objectId": "25544", "maneuver": m, "horizonH": 1, "snapshotId": SNAP})
    assert forced.status_code == 200 and "passed" in forced.json()
    body = {"jobId": f"rs-{time.time_ns()}", "snapshotId": SNAP, "evidenceVersion": "ev-9", "proposalId": "p1",
            "revision": 2, "objectId": "25544", "maneuver": m, "fromUtc": "2026-10-24T11:00:00Z", "toUtc": "2026-10-24T13:00:00Z"}
    r = client.post("/rescreen", headers=H, json=body)
    assert r.status_code == 202 and r.json()["jobId"] == body["jobId"]
    res = wait_job(body["jobId"])["result"]
    assert res["evidenceVersion"] == "ev-9" and res["proposalId"] == "p1" and res["revision"] == 2 and res["snapshotId"] == SNAP


def test_a_restart_never_leaves_a_job_running(tmp_path):
    (tmp_path / "jobs").mkdir()
    (tmp_path / "jobs" / "j1.json").write_text(json.dumps({"jobId": "j1", "kind": "screen", "status": "running"}))
    store = JobStore(tmp_path)
    job = store.get("j1")
    assert job["status"] == "failed" and job["error"]["code"] == "SERVICE_RESTARTED"
    assert json.loads((tmp_path / "jobs" / "j1.json").read_text())["status"] == "failed"


def test_snapshot_manifest_and_omm_asset():
    snap = client.get("/snapshot", headers=H).json()
    assert snap["format"] == "omm" and snap["mode"] == "real" and snap["manifest"]["files"]
    asset = client.get("/snapshot/omm", headers=H)
    assert asset.status_code == 200 and hashlib.sha256(asset.content).hexdigest() == snap["ommFile"]["sha256"]
    records = asset.json()
    assert len(records) == snap["ommFile"]["records"] and all("EPOCH" in r for r in records[:50])


def teardown_module():
    """Remove the job files these tests created in the service's data directory."""
    for p in (appmod.DATA / "jobs").glob("*.json"):
        if p.name.startswith(("screen-t-", "rs-")):
            p.unlink(missing_ok=True)
