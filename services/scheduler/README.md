# Factory schedule worker

This Node 22 service prepares an exact selected maneuver with the Factory Droid SDK and installed CLI, then commits only the reserved immutable preview. It never selects a maneuver, approves it, re-screens it, or commands a spacecraft. Round 4 connects Convex's existing `maneuvers.preview`, `recordPreview`, `reserveCommit`, and `recordCommit` calls to this transport; those functions are unchanged here.

## Provider and isolation

The implementation uses `@factory/droid-sdk/node` 0.10.0 and the official `droid` CLI. The [TypeScript SDK documentation](https://docs.factory.com/sdk/typescript) and installed package declarations/source were checked during implementation. The SDK exposes subtractive tool disabling, so each fresh session discovers tools, disables everything except its one SDK MCP tool, and verifies the resulting tool set before its first turn. Missing or ambiguous tool discovery fails closed. The session uses autonomy Off, disables builtin skills, cancels questions, and permits only the `orbitcall_schedule.write_schedule` permission request. The tool validates exact bytes and has one fixed output path. A model's success text cannot substitute for an actual tool write.

The HTTP process launches a separate SDK runner with an explicit environment allowlist because the SDK inherits its process environment. The runner gets only its Factory key/model, CLI path, and a fresh home/workspace; it receives no service credential, database secret, source checkout, Git directory, or command tool. Its diagnostic output is discarded. No API key, prompt, model response or raw provider error is logged. Session transcripts are removed with the temporary home after a normal run. A crashed preparation is marked failed during restart and is never automatically sent to Factory again.

The worker copies only validated Factory-produced bytes into its isolated schedule repository. The commit step uses deterministic Git commands, not another model call. This is persistence of the real prepared Factory artifact, not a fallback writer when Factory is unavailable. Its resulting commit proves a schedule artifact, not maneuver execution.

## HTTP contract

Every route requires `Authorization: Bearer <SCHEDULE_SERVICE_TOKEN>`, including health and job reads. Place the service behind the existing authenticated HTTPS reverse proxy; do not expose its plain HTTP port publicly.

| Route | Input / result |
| --- | --- |
| `GET /health` | `ready`, service name, SDK version, `providerVerified:false`. 503 when key, model or executable is absent. Readiness verifies configuration and executable access; only a successful real preparation proves provider access. |
| `POST /prepare` | `{ intentKey, filePath, ref, trajectory, entry }` → durable job, 202 while queued/running. |
| `POST /commit` | `{ intentKey, preparedJobId, contentHash, expectedPreviousHash, expectedPreviousCommit, ref, trajectory }` → durable commit job. Must exactly match a completed prepare. |
| `POST /jobs/{jobId}/retry` | `{ expectedAttempt }` → retry the same failed intent, with at most three total attempts. A replay of the same retry command returns the existing attempt. |
| `GET /jobs/{jobId}` | Original immutable request, status (`queued/running/completed/failed`), `attempt`, checked artifact or null, sanitized error or null. |

`ref` contains `eventId`, `proposalId`, `revision`, `selectionGeneration`, `approvalRuleVersion`. `trajectory` is null for today's single-event scheduler, or `{id, version}` for a future authorized shared trajectory. An event intent is `event:<eventId>:proposal:<proposalId>:revision:<revision>:generation:<selectionGeneration>`; a trajectory intent is `trajectory:<id>:version:<version>`. The worker binds the trajectory version but does not invent or verify multi-event approvals: that remains Convex's Round 4 responsibility.

`filePath` is exactly `operators/<companyId>/schedule.json`. `entry` matches `maneuvers.ts`: event/proposal IDs, revision, object ID, whole-second UTC burn time, delta-V in m/s, prograde/retrograde direction and simulated flag. Unknown keys, traversal, malformed IDs and nonfinite numbers are refused. Wait decisions have no schedule entry and must not call prepare.

Completed preparation returns `before`, `after`, the append-only `diff`, SHA-256 `contentHash`, `expectedPreviousHash` (null for a new file), Git `expectedPreviousCommit`, and `{sessionId,modelId,toolWrites:1}` Factory evidence. Commit adds `commitSha`. Rendering and diff exactly match Convex's current validators. **Only the append-only diff belongs in the shared operator UI; `before`/`after` can contain unrelated maneuvers and must stay server-side.**

The Convex client in `convex/lib/scheduleClient.ts` exports `prepareSchedule`, `commitSchedule`, `getScheduleJob`, `retryScheduleJob`, and `getScheduleHealth`. It verifies response identity, reference/version, exact bytes, append-only diff, hashes, receipt, and commit SHA; it sanitizes remote errors, bounds responses and requests once without retrying. Polling is the caller's bounded responsibility. A changed workspace requires a newly authorized intent and fresh preview/approvals, not silently rebasing a prepared artifact.

## Durability and concurrency

Run one daemon for each persistent data volume. The Linux entrypoint acquires an OS `flock` for its entire lifetime; a second instance refuses to start. The in-process queue serializes every preparation and commit. A prepare and a commit each have a deterministic job ID derived from the immutable intent key. Repeating an identical request returns the existing job; changing its body returns a conflict. Files and job journals are written through fsynced temporary files and atomic renames.

After a visible transient failure, an explicit retry uses the same job ID, immutable request and observed attempt number. Retry acceptance is durable and bounded to three total attempts; repeating an old retry command cannot spend again, even if the next attempt has also failed. Factory preparation can retry without changing the selected revision. A commit can retry only after a failure before writing, retaining exactly the original preview and reservation. Stale previews, invalid paths and ambiguous writes require fresh authorization or recovery instead. A preview stays valid while its own operator file is unchanged since the prepare: writes to other operator files may land in between, so several operators' approved plans can commit in any order. Round 4 must recheck current authorization before requesting a retry; this endpoint never grants it.

The commit journal is durable before filesystem mutation. Restart recovery covers interruption before writing, before rename, after rename and after Git commit but before completion recording. Recovery verifies the expected prior commit and exact file content; it never appends the same entry twice or calls Factory again. Ambiguous I/O blocks further writes until restart/reconciliation. Unrelated dirty files, symbolic links, hard links, changed hashes or changed prior Git versions are refused. The journal stops accepting new jobs after 1,000 entries; archival must preserve intent tombstones, so do not delete records casually.

## Build and run

```sh
npm ci --ignore-scripts
npm run check
docker build -t orbitcall-scheduler:reviewed .
```

The Docker image includes Node 22, Git, Linux flock and pinned `droid@0.249.0`. Factory's [official CLI reference](https://docs.factory.com/droid-cli/cli-reference) documents the npm distribution and its disabled automatic updater. The container runs as the unprivileged `node` user. Mount only a dedicated persistent `/data` volume, with write permissions for UID 1000. Use a read-only root filesystem, a small `/tmp` tmpfs, dropped capabilities and `no-new-privileges`; leave the source repository and unrelated secret volumes unmounted.

Set these through the deployment's secret configuration, never a committed file:

- `SCHEDULE_SERVICE_TOKEN`: at least 32 characters; same credential in the Convex service client.
- `FACTORY_API_KEY`: only inside this service.
- `FACTORY_MODEL_ID`: a fixed available model ID, not an automatic provider fallback.
- `DROID_EXEC_PATH`: absolute executable path, `/usr/local/bin/droid` in the image.
- `SCHEDULE_DATA_DIR`: absolute data root, `/data` in the image.
- `PORT`: defaults to 8090.

Convex needs `SCHEDULE_SERVICE_URL` (HTTPS) and `SCHEDULE_SERVICE_TOKEN`. No Factory key belongs in Convex or the browser.

Tests use mocked SDK sessions/HTTP and real temporary Git repositories. No live model call, provider spend or deployment is part of CI. Before sponsor evidence is claimed, deploy with authorized credentials and record one genuine prepare/approved commit trace, checking session ID, exact artifact/diff and Git commit. The current SDK requires Zod 3 and UUID 9 transitively; npm audit reports upstream collection-validation and buffer-overload advisories. HTTP bodies and tool content are bounded before those parsers, and this service does not use the vulnerable UUID buffer overload. An incompatible dependency downgrade or Zod 4 substitution is not silently applied.
