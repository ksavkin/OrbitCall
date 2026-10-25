---
quick_id: 261025-4fb
status: complete
completed: 2026-10-25
branch: kostya/r4-scheduler-file-base (from main 82a7ac4)
key-files:
  modified:
    - services/scheduler/src/engine.ts
    - services/scheduler/tests/worker.test.ts
    - services/scheduler/README.md
---

# 261025-4fb: a prepared schedule write stays valid while its own file is unchanged

Found by running the Convex schedule client against the real worker (`Engine` + `httpServer`): every operator has its own file `operators/<company>/schedule.json` in one Git repository, and Convex prepares the preview when a plan is selected but commits only after all human approvals. The commit required the whole repository HEAD to be unchanged since the prepare, so any other operator's write in between failed every other pending intent with `STALE_WORKSPACE`, with no way out: the retry is `RETRY_UNSAFE` and preparing the same intent again returns the old job. With three operators, the second approved plan of a demo run could never be written.

## Behavior

- **Commit.** Valid while the prepare commit is an ancestor of HEAD and the intent's own file is unchanged between them (`git merge-base --is-ancestor`, `git diff --quiet <prepare commit> HEAD -- <file>`). The byte checks of the file against `before` / `expectedPreviousHash` and the dirty-workspace check are unchanged. A second preview of the SAME file from the same base still fails `STALE_WORKSPACE` after the first commit.
- **Crash recovery.** A commit whose marker is HEAD is accepted when the prepare commit is an ancestor of `HEAD^`, the file at `HEAD^` equals `before` (absent = null) and the working file and HEAD equal `after`.
- **Restart order.** `running` jobs recover before `queued` ones, so a queued write to another file cannot land on top of a committed write whose journal was not saved yet.
- **Result shape** is unchanged: it still echoes the prepare's `expectedPreviousCommit`, which the Convex client checks.

## Tests

- `services/scheduler/tests/worker.test.ts`: 8 new tests: previews of different operator files commit in either order; a second preview of the same file fails after the first commit; crash recovery at three points after another operator's commit; a committed write recovers before a queued write to another file (both orders).
- `npm run check` in `services/scheduler`: 33 tests passing.
- The Convex client against the real worker with two operators preparing from one base: both commits complete.

## Known limits

- Commit jobs already journaled as failed `STALE_WORKSPACE` stay failed; this change prevents new false-stale failures only.
- Two plans for the same operator file still need the second one prepared again after the first commit (a new revision on the Convex side).
