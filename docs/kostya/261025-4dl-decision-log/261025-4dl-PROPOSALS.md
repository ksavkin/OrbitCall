# Proposed changes for the decision log

Status: no spec edit is needed; `log`, its actions and `log.list` already match the spec. The issue #6 text is still for the team to post.

## Issue #6, Round 4 (Kostya), text to add

> - Decision log rows (LOG-2): `proposals.select`, `approvals.approve` and `approvals.veto` each write one shared `log` row (`selected`, `approved`, `vetoed`) with the human actor and side, proposal ID and revision, and the generation or status before and after. Idempotent repeats write nothing. A veto reason stays on the approval row and is never copied into the shared log (spec §4.1, LOG-1, POL-2).
