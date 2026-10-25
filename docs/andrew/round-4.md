# Andrew Round 4 integration handoff

For Adil and Kostya. This describes the implemented Round 4 contracts and the remaining integration work. It is not a claim that these changes are deployed or that the complete demo has passed. Release status and final combined validation belong in [issue #6](https://github.com/ksavkin/OrbitCall/issues/6).

Decisions remain attached to the incident in the Decision Center. Use the existing `proposals.select` and `approvals.status` / `approvals.approve` contracts. A room is the communication channel; entering it is not an approval prerequisite. Only the assigned human's explicit checkmark on the current proposal revision and selection generation counts. Required sides decide in order; confirmed debris needs its active side, and internal review remains non-actionable. Discussion, summaries, rationale, speech and agent feasibility never supply approval.

| Andrew's six tasks | Implementation and integration point |
|---|---|
| Discussion revises options | [`revisions.ts`](../../convex/revisions.ts), [`lib/publishCandidates.ts`](../../convex/lib/publishCandidates.ts). A succeeded Host run with requested revisions, hard constraints or corrections schedules `internal.revisions.fromHost({ hostRunId })`. |
| Candidate explanations | [`agents/rationale.ts`](../../convex/agents/rationale.ts), [`lib/rationale.ts`](../../convex/lib/rationale.ts). `internal.agents.rationale.start({ eventId })`; public `api.lib.rationale.list({ eventId })`. |
| Advocate follow-ups | [`advocates.ts`](../../convex/advocates.ts). Changed publication calls `internal.advocates.publicationFollowups({ eventId, version, evidenceKey })`. |
| Current summary form and edits | [`summary.ts`](../../convex/summary.ts). `api.summary.get`, `api.summary.request`, `api.summary.edit`. |
| Checked Host speech | [`hostTriggers.ts`](../../convex/hostTriggers.ts), [`call/hostSpeech.ts`](../../convex/call/hostSpeech.ts). A succeeded result schedules checked summaries and clarification questions for the existing voice worker. |
| Scheduler deployment configuration | [`deploy/docker-compose.demo.yml`](../../deploy/docker-compose.demo.yml), [`deploy/Caddyfile`](../../deploy/Caddyfile), [`deploy/README.md`](../../deploy/README.md). Dedicated scheduler container, durable workspace and authenticated `/scheduler/*` route. |

## Discussion input and provenance

The Host identifies the relevant incident, existing card and source statements. The revision backend re-reads the **original** human text or final voice phrase and verifies current ownership/assignment. It filters the full fresh `/candidates` grid before choosing the displayed cards; model prose and translations never become numerical input. Changed cards go through canonical publication, fresh Advocate checks and rationale. A materially unchanged result does not create a revision/reset loop.

The current deterministic parser accepts these whole English clauses. `OBJECT` must be the speaker's own assigned object ID, `UTC` must be a valid full `YYYY-MM-DDTHH:mm:ssZ` timestamp, and `N` a positive decimal in m/s.

| Meaning | Accepted clauses |
|---|---|
| Exclusive mover | `move OBJECT only`; `only OBJECT may move`; `only OBJECT can move`; the latter two also accept `maneuver` |
| Cannot move | `cannot move`, `can't move`, `cannot maneuver`, `can't maneuver` |
| Lower time boundary | `burn after UTC`, `maneuver after UTC` (strictly after); `cannot maneuver before UTC`, `can't maneuver before UTC` (boundary included) |
| Upper time boundary | `burn before UTC`, `maneuver before UTC` (strictly before); `cannot maneuver after UTC`, `can't maneuver after UTC` (boundary included) |
| Unavailable window | `cannot maneuver between UTC and UTC`, `can't maneuver between UTC and UTC` (both endpoints excluded from allowed burns) |
| Delta-v bound | `delta-v at most N m/s`, `delta-v at least N m/s` |
| Direction | `use prograde`, `use retrograde`; optional trailing ` direction` |

Clauses are case-insensitive except the exact object ID comparison. Join up to eight clauses with semicolons; a single leading `please `, `we `, `i ` or `our spacecraft ` per clause is accepted, as is one final period/exclamation mark for the whole line. Example: `cannot maneuver before 2026-10-25T23:00:00Z; delta-v at most 0.2 m/s`. Use future times appropriate to the incident during rehearsal.

Local/relative times, unsupported units, Russian/Chinese original prose, mixed sentences, ambiguous exceptions, preferences and hypotheticals require clarification rather than a guessed filter. EN/RU/ZH communication still works; translated English is not substituted for the original source. Unsupported input submitted for revision produces `CLARIFICATION_REQUIRED` and an event-linked room notice, leaving existing cards/approvals intact. A checked correction can release a prior hard constraint while retaining its source audit. Asking to revise several different cards at once also requires clarification.

Text provenance stays in `sourceMessageIds`. Voice provenance retains the real `call_phrases` ID and speaker/source details in the immutable `proposal_revised` audit; where the frozen schema needs a message ID, an explicitly agent-authored bridge is used. A voice phrase is never cast to a message ID or presented as a newly typed human statement. Corrections supersede prior understood entries; a historical Host output is not the current active-understanding list. There is no new public `understood.list` endpoint in these six tasks.

For an explicit retry from the incident, use `api.revisions.request({ eventId, hostRunId })` → `{ accepted: true, alreadyApplied }`. It checks the caller's current turn, deduplicates pending work and bounds retries. A fresh human correction should obtain a fresh checked Host run, rather than repeatedly retrying an obsolete one.

## Summary form: Adil's wiring

Subscribe to `api.summary.get({ eventId })`. Its result is `{ form, selectionGeneration, canEdit, edit }`:

- `form` is null when there is no usable current selection; otherwise it contains `{ proposalId, revision, movingSide, burnTimeUtc, deltaVMs, direction, note }` from the selected candidate. `proposalId` is the actual `Id<"proposals">`, not a display label or stable candidate string.
- `selectionGeneration` belongs with that exact form. Send it back as `expectedGeneration` when editing.
- `canEdit` is a current eligibility hint; the mutation checks authority and freshness again. Heads of operations read only. Also disable duplicate submission while `edit?.state === "pending"`.
- `edit` is null or `{ jobId, state, errorCode }`, with `pending`, `completed` or `failed`. Render a pending state without fabricated percentages; surface failure and reload the form after a stale-revision error.

Call `api.summary.edit({ eventId, proposalId: form.proposalId, baseRevision: form.revision, expectedGeneration: selectionGeneration, changes })`. Allowed changes are `movingSide`, `burnTimeUtc`, `deltaVMs`, `direction`, `note`. The receipt `{ accepted: true }` means queued, not approved or finished. Burns need future UTC whole seconds before TCA, positive delta-v at most 1 m/s, and a current active mover. To change to wait, explicitly clear all four maneuver fields to null. Notes are at most 500 characters.

A maneuver edit runs `/rescreen` over 72 hours, then publishes a new immutable candidate revision. A wait-note edit needs no invented maneuver calculation. Descriptions are regenerated, previous fuel is discarded until Advocates recompute it, and old rationale/preview do not carry into the new revision. Successful publication advances the selection generation and retires old approvals; a failed rescreen leaves the old candidate and decisions intact. Changed inputs, an expired burn, closed/reset run, or reserved/committed schedule artifact prevent publication. Identical submissions are deduplicated; explicit retries are bounded. The durable ledger has a visible 500-event-log limit.

`api.summary.request({ roomId })` asks the Host for `summary_requested` and returns null. The conversation arrives through `messages.list`; always render the editable form from `summary.get`, not a stale room message. The request checks turns on the caller's assigned incidents, so an unrelated pair in a three-company room does not block it. This request never approves anything.

## Explanations, feasibility and trace

`api.proposals.list({ eventId })` supplies cards and selection flags; it does **not** return rationale. Join `api.lib.rationale.list({ eventId })` by `proposalId` **and** `revision`. Each row is `{ proposalId, candidateId, revision, rationale }`; rationale is null while unavailable or stale. A current checked explanation is stored on that immutable revision as `{ text, numbersChecked: true, secondModel: { agrees, note } }`. Show Grok disagreement explicitly, even though the numerical bindings passed. Raw model/checker reasons and private policy values are not shared explanations.

`api.advocates.list({ eventId })` provides current assessments, `mutuallyAcceptable`, `reviewCandidates`, runs and `situation`. `needs_operator_decision` means an option passed the required Advocate checks, not human agreement. `needs_more_data`, `awaiting_advocates`, stale evidence and `no_candidates` are distinct from `no_mutually_acceptable_option`. A deadlock announcement requires fresh complete assessments and an explicit hard rejection of every current option by at least one required side. It produces room/inbox notices and a `negotiation` audit without approving or scheduling.

The publication follow-up hook deduplicates by candidate-set version/evidence and requests both the room Host (`candidates_changed`) and candidate rationale. Empty options produce a visible notice. The regular `spans.list({ eventId, limit? })` / `agentLogs.list` trace APIs also project actual candidate-rationale calls from immutable audit receipts. Drafts use the `analyst` node and checks use `checker`, with the checker parent pointing to that card's draft. Safe output includes `candidateId`, `attempt`, `stage`, `runStatus` and `callStatus`; successful checked batches also include `numbersChecked: true`. Model, provider, duration and reported token usage describe the actual calls. Per-card spans become available when the batch finishes; an unfinished batch is a `handoff` without invented provider timing. Historical Grok verdicts are not stored in these receipts: display the current verdict from the revision-bound rationale query, never infer agreement from a successful checker call.

## Voice and scheduler handoff

Host speech uses `internal.call.hostSpeech.speak({ roomId, hostRunId, text, expectedInputVersion })`. The caller captures the context version **after** publishing the Host's own interpretations. Delivery checks the succeeded run, open room/demo, listeners and current version; later discussion, evidence, selection or assignment changes reject queued speech. Stable run/text IDs deduplicate worker delivery. Translation/TTS uses the existing EN/RU/ZH route; a voice failure cannot roll back written conversation, and no speech records approval.

The scheduler deployment uses the fixed `orbitcall` Compose project and `orbitcall_scheduler_data` volume at `/data`, owned by UID/GID 1000. It holds the isolated Git repository and durable intent journals; preserve/back up them together and never erase the volume to retry. The container has a read-only root, writable `/tmp`, no published worker port and an authenticated Caddy `/scheduler/*` route.

Set `RELEASE_TAG`, `ORBITCALL_API_HOST`, `SCHEDULE_SERVICE_TOKEN` (independent, at least 32 characters), `FACTORY_API_KEY` and a fixed `FACTORY_MODEL_ID` on the deployment host. The image fixes `DROID_EXEC_PATH=/usr/local/bin/droid`, `SCHEDULE_DATA_DIR=/data` and `PORT=8090`. Convex needs `SCHEDULE_SERVICE_URL=https://<host>/scheduler` and the matching `SCHEDULE_SERVICE_TOKEN`; the Factory key belongs only to the worker, never Convex/browser. Authenticated `/scheduler/health` checks configured executable readiness and always reports `providerVerified: false`; live provider access needs separate rehearsal evidence.

Still required before the complete demonstration:

- **Kostya's trajectory API:** discussion revisions fail `TRAJECTORY_PLAN_REQUIRED` and summary edits fail `SHARED_TRAJECTORY_REQUIRED` for shared movers. Do not bypass this with independent pair approvals. One versioned trajectory plan must bind every affected incident's current approval before shared-mover publication/scheduling can be enabled.
- **Kostya's Factory wiring:** connect `maneuvers.ts` to the existing worker/client. `/prepare` supplies the exact preview diff before approval; `/commit` uses the reserved immutable intent only after current human approvals and rescreen. The deployment configuration does not perform this wiring.
- **Release and rehearsal:** activate the reviewed build and settings, perform live Factory prepare/approved commit, prove same-intent retry/restart deduplication, and rehearse the three dispatchers plus observer, voice, revision reset, failure and demo reset paths. A schedule artifact is not maneuver-execution evidence.

Final combined validation is recorded in issue #6. Local mocked-provider/backend tests, deployment configuration checks and a live four-screen rehearsal are separate evidence.
