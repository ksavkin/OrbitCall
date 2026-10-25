# Proposed changes for the UI reads

Status: proposed; the spec edit below is not applied yet. The issue #6 text is still for the team to post.

## Proposed for docs/specification.md

1. **§3.4.** New row `rooms.forEvent`: the incident's most recent room, open or closed, for reading a closed room's history after a reload.

`log.list` (§3.6) and `config.flags` (§3.1) already match their spec rows; the extra `proposals.list` fields are the spec's `Revision` fields (`changeSummary`, `sourceMessageIds`, `rationale`, `schedulePreviewDiff`) plus `candidateId`.

## Issue #6, Round 4 (Kostya), text to add

> - UI reads for wiring the web app: `log.list`, `config.flags`, the full revision fields on `proposals.list`, and `rooms.forEvent`. Read-only; no write path changes.
