"""Numerical jobs (team roadmap §5 "Internal service endpoints"; spec Appendix A): POST /screen and POST /rescreen
reserve a job and answer `{ jobId }`; GET /jobs/{jobId} reports status, phase, measured progress, counters,
coverage and the result.

- The job record is written to ORBIT_DATA/jobs/<jobId>.json BEFORE the reply (acceptance is durable).
- Work runs in a small worker pool outside the request thread, so a client timeout never loses it.
- The caller may name the job (`jobId`; for /screen the scan's `scanId` gives `screen-<scanId>`): a repeat with the
  same body returns the same job (idempotent); the same id with another body is a conflict.
- A restart marks jobs that were queued or running as failed ("service restarted"), so their state is never lost
  or left "running" forever; the caller resubmits.
"""

import hashlib
import json
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

JOB_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
WORKERS = int(os.environ.get("ORBIT_JOB_WORKERS", "2"))  # a re-screen never waits behind one long fleet scan


class JobConflict(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def request_hash(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Progress:
    """Handed to the job function: phase and measured counters, persisted at most once a second."""

    def __init__(self, store: "JobStore", job_id: str):
        self.store, self.job_id, self.last = store, job_id, 0.0

    def __call__(self, phase: str | None = None, progress: float | None = None, **counters) -> None:
        def patch(job: dict) -> None:
            if phase:
                job["phase"] = phase
            if progress is not None:
                job["progress"] = round(progress, 4)
            job["counters"].update(counters)
        self.store.update(self.job_id, patch, persist=time.monotonic() - self.last > 1.0 or bool(phase))
        self.last = time.monotonic()


class JobStore:
    def __init__(self, data_dir: Path):
        self.dir = data_dir / "jobs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="orbit-job")
        for p in self.dir.glob("*.json"):
            try:
                job = json.loads(p.read_text())
            except ValueError:
                continue
            if job.get("status") in ("queued", "running"):
                job.update(status="failed", phase="failed", finishedAt=_now(),
                           error={"code": "SERVICE_RESTARTED", "message": "the service restarted before the job finished; resubmit"})
                self._write(job)
            self.jobs[job["jobId"]] = job

    def _write(self, job: dict) -> None:
        tmp = self.dir / f".{job['jobId']}.tmp"
        tmp.write_text(json.dumps(job))
        tmp.replace(self.dir / f"{job['jobId']}.json")  # atomic

    def update(self, job_id: str, patch, persist: bool = True) -> None:
        with self.lock:
            job = self.jobs[job_id]
            patch(job)
            if persist:
                self._write(job)

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job)) if job else None  # a copy: the worker keeps mutating its own

    def submit(self, kind: str, job_id: str | None, body: dict, fn) -> tuple[dict, bool]:
        """Reserves (and persists) the job, then runs fn(progress) in the pool. Returns (job, created)."""
        job_id = job_id or f"{kind}-{uuid.uuid4().hex[:16]}"
        if not JOB_ID_RE.fullmatch(job_id):
            raise ValueError("jobId must be 1-128 characters of letters, digits and . _ : -")
        h = request_hash(body)
        with self.lock:
            old = self.jobs.get(job_id)
            if old is not None:
                if old["kind"] != kind or old["requestHash"] != h:
                    raise JobConflict(f"job {job_id} exists with another request")
                if old["status"] != "failed":
                    return json.loads(json.dumps(old)), False
            job = {"jobId": job_id, "kind": kind, "status": "queued", "phase": "queued", "progress": None,
                   "counters": {}, "requestHash": h, "request": body, "createdAt": _now(), "startedAt": None,
                   "finishedAt": None, "result": None, "resultRef": None, "error": None}
            self.jobs[job_id] = job
            self._write(job)  # durable before the reply
        self.pool.submit(self._run, job_id, fn)
        return self.get(job_id), True

    def _run(self, job_id: str, fn) -> None:
        self.update(job_id, lambda j: j.update(status="running", startedAt=_now()))
        try:
            result = fn(Progress(self, job_id))
            ref = f"jobs/{job_id}.json#result"

            def done(j: dict) -> None:
                j.update(status="completed", phase="done", progress=1.0, finishedAt=_now(), result=result, resultRef=ref)
                if isinstance(result, dict) and isinstance(result.get("coverage"), dict):
                    j["coverage"] = result["coverage"]
            self.update(job_id, done)
        except Exception as exc:  # noqa: BLE001 — every failure is reported on the job, never lost
            code = "VALIDATION" if isinstance(exc, (ValueError, KeyError, TypeError)) else "ERROR"
            self.update(job_id, lambda j: j.update(status="failed", phase="failed", finishedAt=_now(),
                                                   error={"code": code, "message": str(exc)[:500]}))
