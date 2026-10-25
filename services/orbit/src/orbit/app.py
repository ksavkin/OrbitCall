"""FastAPI app: the endpoints of team spec Appendix A, with the contract additions of docs/contract.md.

One process, catalog in memory, loaded once at startup: the pinned OMM snapshot (real mode, default) or, only with
ORBIT_CATALOG_MODE=tle, the TLE development snapshot; plus simulated objects from ORBIT_DATA/sim. Every request
needs the X-Service-Token header (ORBIT_SERVICE_TOKEN). /screen and /rescreen are jobs (jobs.py): the request is
validated, the job is persisted, `{ jobId }` comes back at once and GET /jobs/{jobId} reports it. The catalog is
copy-on-write, so reads need no lock; only /simulate (the one mutation) takes the lock.
"""

import copy
import hashlib
import hmac
import json
import os
import threading
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import candidates as cand
from . import rescreen as resc
from . import screen as scr
from . import simulate as sim
from . import verify as ver
from .catalog import load_snapshot
from .jobs import JobConflict, JobStore
from .objects import RULE, classify
from .validation import ValidationCache

DATA = Path(os.environ.get("ORBIT_DATA", Path(__file__).resolve().parents[2] / "data"))
TOKEN = os.environ.get("ORBIT_SERVICE_TOKEN", "")

app = FastAPI(title="OrbitCall orbital service")
catalog = load_snapshot(DATA)
sim.reload_sims(catalog, DATA)
lock = threading.Lock()
# Validation compares with the SOCRATES run of 2026-10-24T01:47Z, so it uses the pinned snapshot closest to that run
# (the team's TLE files, fetched 6 h later); the result names that snapshot and its format.
validation_cache = ValidationCache(lambda: load_snapshot(DATA, "tle"), DATA)
jobs = JobStore(DATA)
ECHO = ("proposalId", "revision", "runId")  # versions a caller may pass; echoed in results (roadmap §5)


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status, {"code": code, "message": message})


@app.exception_handler(HTTPException)
def http_error(_: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "ERROR", "message": str(exc.detail)}
    return JSONResponse({"error": detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
def validation_error(_: Request, exc: RequestValidationError):
    return JSONResponse({"error": {"code": "VALIDATION", "message": str(exc.errors()[:3])}}, status_code=400)


def auth(x_service_token: str = Header(default="")) -> None:
    if not TOKEN or not hmac.compare_digest(x_service_token.encode(), TOKEN.encode()):
        raise ApiError(401, "UNAUTHORIZED", "missing or wrong X-Service-Token")


def run(fn, *args, mutates: bool = False):
    try:
        if mutates:
            with lock:
                return fn(*args)
        return fn(*args)
    except scr.SnapshotMismatch as e:
        raise ApiError(409, "SNAPSHOT_MISMATCH", str(e))
    except JobConflict as e:
        raise ApiError(409, "JOB_CONFLICT", str(e))
    except cand.NotFound as e:
        raise ApiError(404, "NOT_FOUND", f"object {e} is not in snapshot {catalog.snapshot_id}")
    except KeyError as e:
        raise ApiError(400, "VALIDATION", f"missing field {e}")
    except (ValueError, TypeError) as e:
        raise ApiError(400, "VALIDATION", str(e))


@app.get("/health")
def health():
    return {"ok": True, "snapshotId": catalog.snapshot_id, "objects": len(catalog.objects)}


def _omm_asset() -> tuple[bytes, str]:
    """The catalog's OMM records (real mode: as received; simulated objects: built from their exact elements)."""
    objs = catalog.objects
    cached = getattr(_omm_asset, "cache", None)
    if cached and cached[0] is objs:
        return cached[1], cached[2]
    records = [o.omm for o in objs.values() if o.omm is not None]
    body = json.dumps(records, separators=(",", ":")).encode()
    digest = hashlib.sha256(body).hexdigest()
    _omm_asset.cache = (objs, body, digest, len(records))
    return body, digest


@app.get("/snapshot", dependencies=[Depends(auth)])
def snapshot():
    body, digest = _omm_asset() if catalog.format == "omm" else (b"", None)
    return {"snapshotId": catalog.snapshot_id, "takenAt": catalog.taken_at, "format": catalog.format,
            "mode": "real" if catalog.format == "omm" else "development (TLE, explicit ORBIT_CATALOG_MODE=tle)",
            "sources": catalog.sources, "manifest": catalog.manifest,
            "objectCount": len(catalog.objects), "skipped": len(catalog.skipped), "skippedSample": catalog.skipped[:20],
            "simulated": [o.object_id for o in catalog.objects.values() if o.simulated],
            "ommFile": {"path": "/snapshot/omm", "sha256": digest, "bytes": len(body), "snapshotId": catalog.snapshot_id,
                        "records": _omm_asset.cache[3]} if digest else None}


@app.get("/snapshot/omm", dependencies=[Depends(auth)])
def snapshot_omm():
    """The OMM asset Convex stores and serves to browsers through a backend-issued file URL (roadmap §5)."""
    if catalog.format != "omm":
        raise ApiError(404, "NOT_FOUND", "development mode (TLE) has no OMM asset")
    body, digest = _omm_asset()
    return Response(body, media_type="application/json", headers={"ETag": digest, "X-Snapshot-Id": catalog.snapshot_id})


def _echo(body: dict, result: dict) -> dict:
    return {**result, **{k: body[k] for k in ECHO if k in body}}


@app.post("/candidates", dependencies=[Depends(auth)])
def candidates(body: dict):
    return _echo(body, run(cand.candidates, catalog, body))


def _job(kind: str, body: dict, job_id: str | None, parse, work):
    run(parse, catalog, body)  # bad requests fail now with 400/404/409, before any job exists
    view = copy.copy(catalog)  # the job keeps the catalog view it was accepted on: a later /simulate rebinds
    # catalog.objects (copy-on-write) and never changes this copy's dict
    job, created = run(jobs.submit, kind, job_id, body, lambda progress: _echo(body, work(view, body, progress)))
    return JSONResponse({"jobId": job["jobId"], "status": job["status"], "created": created,
                         "statusUrl": f"/jobs/{job['jobId']}"}, status_code=202 if created else 200)


@app.post("/rescreen", dependencies=[Depends(auth)])
def rescreen(body: dict, wait: int = 0):
    """A job (spec Appendix A). Compatibility: ?wait=1, or a v1-shaped request (no snapshotId and no jobId, as the
    current Convex provider sends), returns the Rescreen synchronously — deprecated once Convex polls /jobs."""
    if wait or ("snapshotId" not in body and "jobId" not in body):
        return _echo(body, run(resc.rescreen, catalog, body))
    return _job("rescreen", body, body.get("jobId"), resc.parse, resc.rescreen)


@app.post("/verify", dependencies=[Depends(auth)])
def verify(body: dict):
    if "expected" not in body:
        raise ApiError(400, "VALIDATION", "missing field 'expected'")
    replay = ver.load_replay(DATA, body["replay"]) if body.get("replay") else None
    if body.get("replay") and replay is None:
        raise ApiError(404, "NOT_FOUND", f"replay {body['replay']} is not available")
    oid = str(body.get("objectId", ""))
    if replay is not None and replay.get("objectId") != oid:
        raise ApiError(400, "VALIDATION", f"replay {body['replay']} is for object {replay.get('objectId')}, not {oid}")
    obj = catalog.get(oid)
    if replay is None and obj is None:
        raise ApiError(404, "NOT_FOUND", f"object {oid} is not in snapshot {catalog.snapshot_id}")
    # The simulated label comes from the catalog (or the replay file), never from the caller.
    body = {**{k: v for k, v in body.items() if k not in ("simulated", "objectSimulated")},
            "objectSimulated": bool(obj and obj.simulated)}
    return run(ver.verify, body, replay)


@app.post("/simulate", dependencies=[Depends(auth)])
def simulate(body: dict):
    return run(sim.simulate, catalog, body, DATA, mutates=True)


@app.post("/screen", dependencies=[Depends(auth)])
def screen(body: dict, wait: int = 0):
    """A job: { jobId } at once (job id = body.jobId, else screen-<scanId>); ?wait=1 runs it inline (tests, tools)."""
    if wait:
        return _echo(body, run(scr.screen, catalog, body))
    job_id = body.get("jobId") or (f"screen-{body['scanId']}" if body.get("scanId") else None)
    return _job("screen", body, job_id, scr.parse, scr.screen)


@app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
def job_status(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise ApiError(404, "NOT_FOUND", f"no job {job_id}")
    job.pop("request", None)
    return job


@app.get("/validation", dependencies=[Depends(auth)])
def validation(snapshotId: str | None = None):  # noqa: N803 — query parameter name of the contract
    if snapshotId is not None and snapshotId != catalog.snapshot_id:
        raise ApiError(409, "SNAPSHOT_MISMATCH", f"snapshotId {snapshotId} is not the loaded snapshot {catalog.snapshot_id}")
    result, state = validation_cache.get()
    if result is not None:
        return result
    msg = "validation run started; it takes a few minutes, retry" if state == "running" else f"previous run {state}; restarted"
    return JSONResponse({"error": {"code": "NOT_READY", "message": msg}}, status_code=503, headers={"Retry-After": "60"})


@app.get("/objects/{object_id}", dependencies=[Depends(auth)])
def object_info(object_id: str):
    obj = catalog.get(object_id)
    if obj is None:
        raise ApiError(404, "NOT_FOUND", f"object {object_id} is not in snapshot {catalog.snapshot_id}")
    return {**classify(catalog, obj), "snapshotId": catalog.snapshot_id, "rule": RULE}


@app.post("/objects", dependencies=[Depends(auth)])
def objects_info(body: dict):
    ids = body.get("objectIds")
    if not isinstance(ids, list) or len(ids) > 1000:
        raise ApiError(400, "VALIDATION", "objectIds must be a list of at most 1000 ids")
    found = {str(i): classify(catalog, catalog.objects[str(i)]) for i in ids if str(i) in catalog.objects}
    return {"snapshotId": catalog.snapshot_id, "rule": RULE, "objects": found,
            "missing": [str(i) for i in ids if str(i) not in catalog.objects]}
