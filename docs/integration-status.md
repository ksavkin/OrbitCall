# Team handoff: merged frontend, Phase 1 backend and product decisions

Updated October 24, 2026. Start with [the locked master roadmap](master-roadmap.md), the team's source of truth for scope, stack, phases, and deployment. This file records the implementation handoff. Version 1.1 adds Gemini as Coordination Host, with runtime work still pending.

## Code included in this reconciliation

- Latest `adil` frontend, including scan/demo flow, decision dock, agent camera, resolution screen and alerts.
- `kostya/phase1-plan` through `185041e`, including the already-merged `andrew-phase1-analyst` implementation.
- Root Convex package, normalized Phase 1 schema, snapshot loader and catalog queries, Risk Monitor, checked Incident Analyst, mocked-model tests and backend CI.
- Frontend Convex provider, snapshot/queue integration and error boundaries, preserved alongside the development simulator.
- OMM snapshot work through `ec5ea34`: pinned GP/SATCAT inputs, static web index/files, nullable/string `ommUrl`, direct OMM loading/propagation, and SOCRATES queue rows restricted to objects in that catalog.

`main` and `adil` are synchronized through this integration. The shared [UI design system](adil/design-system.md) is included in Git alongside the product decisions. Historical feature-branch tips remain intact. New work can use feature branches; synchronize through reviewed merges. Shared Git content does not mean the team's cloud deployment, credentials or local environments have been configured.

## Accepted product decisions

The [assigned-fleet user flow](user-flow.md) is the starting point. The [specification](specification.md) defines the target contract, and [functionality](functionality.md) preserves stable requirement IDs.

| Topic | Decision |
|---|---|
| Dashboard | My Fleet + My Incidents + globe, all assigned objects listed with positions and freshness |
| Demo identities | Three dispatcher laptops, four assigned spacecraft each, and a read-only observer display. Group rooms support 2-4 operators. Assignments are simulated; country is not authorization |
| Run Scan | Server-resolved assigned fleet versus every other usable object in the pinned catalog, next 72 hours; explicit progress and coverage |
| Priority | Severity first, then earliest closest approach. Missing/stale evidence in a separate visible review section. No Pc/time score |
| Queue source (Oct 25) | My Incidents lists only events from our own fleet scan (`scans.startMine`, which calls the orbital service's `POST /screen`). Before the first scan the queue is empty and asks for Run Scan. SOCRATES pairs are never the queue |
| Reference check (Oct 25) | Every scan event is checked against the SOCRATES reference list: "Matched in SOCRATES", "Data differs" or "Not in SOCRATES", with their TCA, miss and probability side by side with ours. Provenance, not a confidence score. Validation (`GET /validation`) uses the full eligible list, not a top-N subset |
| Run Scan access (Oct 25) | Shown on Orbit and Conjunctions. Signed out or without assignments: visible, not runnable, and it says why. Only provisioned accounts start paid work |
| Navigation (Oct 25) | Four tabs: Orbit, Decision Center, Policy, Inbox. Conjunctions and Rooms merge into Orbit (scan, cases, agents) and Decision Center (case, plan cards, call). Audit log becomes Inbox. See user-flow "App navigation" |
| Decision turns (Oct 25) | Side A, then B, then other parties. Only the party whose turn it is has active Approve, Veto, voice and text during the decision; everyone can discuss before it |
| Voice in decisions (Oct 25) | Voice can select a card ("option B"); approval and veto stay explicit clicks |
| Probability display (Oct 25) | "1 in N" is the main reading (`1 in 770`), because people grasp it at once. The exact value sits next to it, smaller: two significant digits as a decimal from 0.0001 up (`0.0013`), scientific below (`1.3 × 10⁻⁷`). SOCRATES values keep the `max_prob` label |
| TCA | Time of Closest Approach; display "Time until closest approach" / "До ближайшего сближения" |
| Proposals | Up to four computed candidates. Show fewer if fewer exist |
| Selection | Shared selected candidate, separate from each human's Approve. Selecting an alternative is not a counter |
| Counter | Ordinary text/voice discussion, not an approval state or structured form |
| Two active operators | Both assigned sides approve the same current selection generation, proposal and revision |
| Confirmed debris | One real active-object operator approves; never fabricate debris approval. An absent active operator is not debris |
| Completion | Scheduled is distinct from observed execution. Historical verification is explicitly replay |
| Languages | English, Russian, Mandarin; LiveKit, Grok STT, Claude translation, Cartesia EN/ZH, Grok RU |
| Agent providers | Claude Analyst/Advocates and translation, Gemini Coordination Host, Grok independent rationale check and selected audio tasks. Gemini uses the official Google SDK in a Convex Node action |
| Hosting | Vercel frontend, Convex app backend, DigitalOcean containers for numerical/voice/Factory services |
| Extra sponsors | Factory schedule artifacts, Backboard memory context, Tiger Data historical analytics, with Convex authoritative |

## Data modes: latest user decision

**Dev on:** retain the existing CelesTrak TLE catalog and synthetic event/agent scenarios for UI development and demos. Real catalog elements and synthetic encounter evidence must be distinguished.

**Dev off:** Convex names the pinned OMM catalog index through `catalog.snapshot.ommUrl`. The browser loads the index and group files from `web/public/snapshots/`, checks their hashes in a secure context, and propagates OMM directly through the shared worker. Missing or invalid OMM keeps a waiting/error state. Real mode never calls the development `/api/catalog` TLE loader or silently substitutes local synthetic incidents. The loader and renderer are merged. The target backend demo run may separately process explicitly labeled simulated encounters through the real services.

Current queue geometry is supplied by SOCRATES. Restricting those rows to catalog object IDs does not re-screen them numerically against the newer GP elements. Assigned-fleet scanning remains a separate implementation task. See [data preparation](../data/README.md) for the pinned sources, publication scripts and static catalog path.

**Decision, October 25, 2026 (Adil; Kostya and Andrew to confirm):** the frontend stops presenting `events.catalogPairs` as the working queue. My Incidents shows the signed-in fleet's scan results (`events.myQueue`) and stays empty until a scan has run. SOCRATES becomes the reference each scan event is checked against (`EventRow.reference`, spec §2.2). `catalogPairs` remains available for a separate Explore view. Owners: `convex/scans.ts` (Kostya, round 2 in #6), the queue UI under `web/src/components/queue/` (Adil, round 2).

Both modes live in both Git branches. `main` is a branch, not a runtime switch. CelesTrak remains the source in either format. OMM supports larger catalog IDs and structured exchange, but changing serialization alone does not guarantee better orbit accuracy. See [CelesTrak's format documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php).

## Implemented versus pending

Andrew's Phase 1 stretch now supplies private company policy endpoints, trusted account/assignment provisioning and a bounded two-Advocate evaluation with sanitized shared outcomes. It has immutable candidate revisions and guards against policy/evidence changes during a run. See [Operator Advocate v1](operator-advocate-v1.md) for the implemented contracts. This is a backend integration seam: Auth0/browser login, full fleet APIs, room selection/approval, unilateral debris, frontend rendering and scheduling remain pending. The table below describes the original merged Phase 1 baseline.

| Implemented Phase 1 | Accepted target still pending |
|---|---|
| Normalized snapshots, spaceObjects, events and agentRuns | Users, fleet assignments and assignment-authorized subscriptions |
| Pinned SOCRATES snapshot and catalog-pair ingestion | Assigned-fleet-versus-catalog scan jobs and coverage/progress |
| Pinned OMM inputs, web catalog index/files, Convex URL, frontend loader and OMM worker propagation | Shared-deployment validation and numerical screening of assigned fleets against the same pinned inputs |
| Public catalog inspection, current coloring and Analyst runtime | Fleet-scoped personal queues, selected severity/time ordering and review sections |
| Frontend Dev switch, simulator, Convex bridge and error boundaries | Authenticated rooms, candidate revisions, selection generation, approvals and unilateral debris |
| Mocked-model tests and backend CI | Shared-deployment/live-provider smoke test, scheduling, verification and reports |
| Analyst provider integration only | Gemini Host SDK/configuration, validated host outputs, and actual provider/model traces across Claude, Grok and Gemini |

The Phase 1 public catalog queries are not the private assigned-fleet application. Do not add private policy or approval writes to these unauthenticated endpoints. New real-mode work must follow the assignment/identity rules in the specification.

## Integration order

1. Deploy the merged OMM snapshot contract and load its manifest into the shared Convex deployment. The validator now permits a string URL. Publish the matching static assets in the same Vercel release.
2. Validate real-mode loading and direct OMM propagation against that deployed index. Keep missing/error states explicit. Implement the numerical screening service separately, with pinned inputs and reported coverage. Do not present the current SOCRATES queue as that service's calculated output.
3. Implement assignments and `users.me` / `fleet.listMine`, then `scans.startMine` / `scans.getMine`, `events.myQueue` and `events.orbits`. The new signatures are target APIs, not currently deployed functions.
4. Implement shared candidate selection and workflow-specific current approvals, with privacy, re-screening and idempotent scheduling. Keep simulator states distinct from live evidence.
5. Implement the Gemini Coordination Host against checked shared context. Configure its server-only key and pinned model, validate referenced facts, and demonstrate a live clarification/summary. Keep Claude's analysis/advocate/translation work and Grok's independent check distinct in the trace.

See [Kostya's implementation history](kostya/phase1/plan.md) and [Andrew's runtime guide](phase1-andrew.md) for existing code. The latest workflow/mode decisions above supersede their old global-queue or real-mode TLE fallback descriptions.

## Local validation and deployment

Root backend: `npm ci`, then `npm run check`. Frontend: `cd web`, `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

Frontend backend access requires `NEXT_PUBLIC_CONVEX_URL`. Live Analyst execution requires the model/provider settings in the Phase 1 guide. Repository synchronization does not deploy Convex or supply credentials. No live model call or cloud deployment is claimed by local tests.

Historical validation at `0ed8496`: backend TypeScript and 58 tests passed, plus frontend TypeScript, ESLint and production build. That browser smoke test verified the earlier waiting state and TLE mode switch. It did not validate the newly merged OMM loader. Current OMM/shared-deployment and provider checks must be recorded separately.

Validation after merging `ec5ea34`: backend TypeScript and all 59 tests passed. Frontend TypeScript, ESLint and production build passed. All six published OMM group files match their pinned hashes and source copies, covering 19,468 unique object IDs across those files. Existing build warnings remain for multiple lockfiles and weather-cache filesystem tracing. This run did not validate a live shared deployment or call the agent/voice providers.
