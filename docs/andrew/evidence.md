# Andrew's provider evidence

This record supports issue #6, Round 3's provider-evidence task and the roadmap's Phase 6, 7 and 10 evidence. It distinguishes a checked live provider call from a complete product demonstration.

## Current evidence status

The diagnostic is implemented in `convex/providerReadiness.ts`. Its regression tests run the real action, validation, memory and SQL-adapter paths with mocked external transports. **Those tests are not live provider evidence.** The first live check below succeeded for Claude, Grok, Backboard and Tiger; Gemini rejected the request. No shared Convex deployment was changed to create or run this diagnostic.

The remaining provider proof is a successful checked Gemini call. Even a passing diagnostic does not complete the phase checkboxes: the operator-facing integration and rehearsal listed below remain necessary.

### Live check recorded on October 25, 2026

Executed at **2026-10-25 11:15:05.237 UTC**, using the new diagnostic in a local `convex-test` Node harness and live external provider credentials. The database and the run/incident IDs below are local harness records, not records from the shared Convex deployment. The provider requests, Backboard write/recall/deletion and Tiger SQL write/read were live. The overall diagnostic correctly returned **`failed`**, with **`cleanup: complete`**.

| Provider | Result | Returned model | Duration | Reported input / output tokens | Evidence |
| --- | --- | --- | ---: | ---: | --- |
| Claude | Succeeded | `claude-sonnet-5-5` | 2,634 ms | 909 / 258 | All five lines passed the evidence template and number checks. |
| Gemini | **Failed** | `gemini-3.8-flash` was the configured target; no successful returned model | 3,348 ms | Unavailable | `REQUEST_REJECTED`; no output was published. The cause still needs diagnosis. |
| Grok | Succeeded | `grok-4.20-0309-reasoning` | 4,135 ms | 465 / 493 | `agrees: true`, no flagged candidates. The explanation correctly said that no candidates had been published. |
| Backboard | Succeeded | Not applicable | 3,842 ms | Not applicable | The exact newly written preference and its source event/message were recalled. The isolated assistant was cleaned up. |
| Tiger | Succeeded | Not applicable | 2,698 ms | Not applicable | A live SQL export returned through the history cache with the exact simulated timestamp and `missKm: 1.25`, `pc: null`; cache version 1. |

Sanitized source identifiers from this check:

```json
{
  "execution": "Local convex-test harness with live external providers; shared Convex deployment unchanged",
  "runId": "000000000000000000010000demoRuns",
  "eventId": "00000000000000000000010005events",
  "messageId": "000000000000000000010008messages",
  "agentRunId": "00000000000000000010011agentRuns",
  "exportId": "00000000010009observationExports",
  "observedAt": "2026-10-25T11:14:59.086Z",
  "evidenceVersion": "provider_readiness_v1:000000000000000000010000demoRuns",
  "source": "simulated",
  "simulated": true,
  "missKm": 1.25,
  "pc": null,
  "status": "failed",
  "cleanup": "complete"
}
```

This receipt establishes four working provider paths from the local integration harness. It does not show a successful Gemini request, execution of this diagnostic on the shared Convex deployment, a rendered chart or a completed human workflow.

## What the diagnostic proves

`providerReadiness.run` is an internal action, callable by an authorized backend operator. It has no public browser endpoint, startup trigger, cron invocation or health-check side effect. It requires the literal confirmation `RUN_LIVE_PROVIDER_CHECKS` because invoking it makes provider requests and can incur normal provider charges.

Each invocation creates a new, clearly labeled simulated `demoRuns` record, company, pair of synthetic objects, incident, room and diagnostic source message. The fixture uses no real satellite ownership, assignment, private policy or existing room. It creates no proposals, signatures, approvals or schedule artifacts. Its probability is below the automatic Analyst trigger threshold; the diagnostic explicitly starts its own Analyst once.

| Provider | Actual application path exercised | Required success evidence |
| --- | --- | --- |
| Claude | `agents.analyst.start` → the configured Anthropic model → `agentRuns.finish` | A succeeded run with all five summary lines checked against the fixture's authoritative evidence. The manifest stores its run ID, rendered summary, actual returned model and reported token usage. |
| Gemini | `coordinationHost.run` → the configured Gemini model → the Host output checks | A checked summary for the fixture incident, with valid references and no invented numerical claims or human approval. Empty output is a failed diagnostic. The manifest stores the checked output, actual model, usage and duration. |
| Grok | `rationaleCheck.run` → the configured xAI model → the checker contract | A valid checked result about the synthetic explanation. `agrees: false` is a successful provider response and remains visible; it does not authorize anything. This minimal probe supplies no computed maneuver candidates. |
| Backboard | `createRunAssistant` → checked `buildMemoryItem` → `writeMemory` → `recallMemory` | The exact newly written memory ID, preference text, company and source references must return from the run's isolated assistant. A successful search with no matching memory fails the diagnostic. |
| Tiger Data | The existing `historyActions.exportObservation` and `historyActions.refreshSeries`, using the server-side `pg` adapter | A simulated, run-tagged observation is exported and read back into a fresh cache with the exact timestamp, source and `missKm` value. Merely creating an export row or opening a connection is insufficient. |

The diagnostic prepares its own immutable observation ledger row through the same checked `exportFields` mapper. It invokes the export action immediately instead of competing with an already scheduled initial export. The export and cache read use the real history actions. This proves the SQL path; scan-to-history publication is a separate Round 3 task.

The five checks run independently in parallel. A provider failure does not skip the other providers. Model adapters make one request per explicit attempt and do not substitute another model. Backboard makes the separate create, write, recall and cleanup requests its API requires. Tiger's existing export action retains its bounded retry policy; closing the diagnostic fences queued retries and refreshes.

## Running and saving a live check

First merge and deploy the reviewed backend through the team's normal release process. This task does not deploy an unmerged branch to the shared environment. Confirm that the intended deployment has:

- `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`;
- `GEMINI_API_KEY` and `GEMINI_HOST_MODEL`;
- `XAI_API_KEY` and `XAI_CHECKER_MODEL`;
- `BACKBOARD_API_KEY`;
- `TIGER_DATABASE_URL` and the TLS configuration required by the existing Tiger adapter, including `TIGER_DATABASE_CA` when using the team's custom CA configuration.

Use the locked model IDs from the roadmap and record the model the provider actually returns. A configured key or model ID is not proof that the request succeeded. Never copy keys, database URLs or raw provider error bodies into the evidence file, issue or PR.

Invoke the already deployed function for an explicitly selected deployment:

```sh
npx convex run --deployment-name YOUR_DEPLOYMENT providerReadiness:run \
  '{"confirmation":"RUN_LIVE_PROVIDER_CHECKS"}'
```

The result contains:

```text
runId
status: passed | failed | interrupted
cleanup: complete | failed | pending
results[]:
  provider, status, model, usage, durationMs, errorCode, resultJson
```

All five provider results must say `succeeded`, the overall status must be `passed`, and cleanup must be `complete` before calling the entire diagnostic successful. The `resultJson` fields contain checked synthetic output or small receipts; durations and usage come from the actual run. A result with `failed` is evidence of a failed attempt, not evidence of provider readiness.

The persisted report can be fetched later using its returned run ID:

```sh
npx convex run --deployment-name YOUR_DEPLOYMENT providerReadiness:report \
  '{"runId":"RETURNED_RUN_ID"}'
```

The report is held in that diagnostic's `demoRuns.manifest` under `readiness:*` keys. Each finished provider check is saved independently, so an interruption can preserve partial evidence without claiming the unfinished checks passed. Preserve this sanitized JSON, its commit/deployment, invocation time and execution environment in the demonstration record. A local integration harness using live providers must be labeled as local; it does not prove that the shared Convex deployment ran the new function.

## Isolation and cleanup

On completion, the action closes only its own incident and room and deletes the memories and Backboard assistant it created. The synthetic Convex records and source-tagged Tiger row remain as an audit trail; they are not catalog data or a current live incident. A scheduled cleanup after ten minutes handles an interrupted caller. There is no account-wide Backboard listing or deletion.

Cleanup closes the fixture before contacting Backboard. A memory write that completes after closure schedules another cleanup for its exact namespace, so an early cleanup receipt cannot cover a later write. Known assistant IDs remain in `memoryAssistants` when deletion fails. Retry cleanup of that one run explicitly:

```sh
npx convex run --deployment-name YOUR_DEPLOYMENT providerReadiness:cleanup \
  '{"runId":"RETURNED_RUN_ID"}'
```

If creating the assistant times out without returning an ID, `readiness:assistantCreation` stays `pending` and cleanup is reported as failed. The service may have created an assistant despite the missing response. Inspect that specific diagnostic's assistant name (`orbitcall:<companyId>:<runId>`) in Backboard before declaring cleanup complete; the code cannot safely guess its ID or delete unrelated namespaces. No automatic repeat create is made.

An immediate recall can miss a newly indexed memory. The result remains `MEMORY_NOT_RECALLED`; it is not silently retried or counted as success. Diagnose the provider behavior before starting another explicitly identified run.

## Product demonstrations still required

| Roadmap phase | Diagnostic contribution | Additional demonstration required |
| --- | --- | --- |
| Phase 6: Calculated options | A real checked Claude incident summary. | Real numerical candidate generation, private-policy Advocate evaluation and operator comparison of feasible alternatives. The synthetic diagnostic is not orbital validation. |
| Phase 7: Shared coordination | A real checked Gemini Host response and an independent Grok result. | The actual conjunction workflow, shared room, human text/voice context, visible Host output and discussion-driven revisions. This probe does not verify speech, translated audio or the optional-room UI flow. |
| Phase 10: Memory, history and evidence | An exact Backboard write/recall and a source-tagged Tiger write/read. | A human preference carried from a completed incident into a later Advocate prompt with source references, and a rendered historical series with provenance. The diagnostic's labeled system message is not a fabricated human interaction. |

Factory scheduling, DigitalOcean worker health, Auth0, the LiveKit/Cartesia/Grok speech path and the four-screen rehearsal have their own evidence. This diagnostic does not claim to validate them or to show an executed maneuver.
