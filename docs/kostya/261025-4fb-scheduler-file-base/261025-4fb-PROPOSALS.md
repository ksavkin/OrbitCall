# Proposed changes for the schedule worker staleness check

Status: proposed; the README sentence below is not applied yet. The issue #6 text is still for the team to post.

## Proposed for services/scheduler/README.md

1. **Retries paragraph.** Adds: a preview stays valid while its own operator file is unchanged since the prepare; writes to other operator files may land in between, so several operators' approved plans can commit in any order.

## Issue #6, Round 4, text to add under "Scheduler wiring"

> - Worker fix: a prepared write stays valid while its own operator file is unchanged, so another operator's write between preview and commit no longer fails it with `STALE_WORKSPACE`. Edits `services/scheduler/` only.

## Note for deploy

- Rebuild and redeploy the scheduler image; the data volume and its journals are compatible.
