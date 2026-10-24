# Team handoff: merged frontend, Phase 1 backend and product decisions

Updated October 24, 2026. Start here before implementing the next backend or frontend change.

## Code included in this reconciliation

- Latest `adil` frontend, including scan/demo flow, decision dock, agent camera, resolution screen and alerts.
- `kostya/phase1-plan` through `185041e`, including the already-merged `andrew-phase1-analyst` implementation.
- Root Convex package, normalized Phase 1 schema, snapshot loader and catalog queries, Risk Monitor, checked Incident Analyst, mocked-model tests and backend CI.
- Frontend Convex provider, snapshot/queue integration and error boundaries, preserved alongside the development simulator.

`main` and `adil` should point to the same reviewed integration commit when this sync is pushed. Historical feature-branch tips remain intact. New work can use feature branches; synchronize through reviewed merges. Shared Git content does not mean the team's cloud deployment, credentials or local environments have been configured.

## Accepted product decisions

The [assigned-fleet user flow](user-flow.md) is the starting point. The [specification](specification.md) defines the target contract, and [functionality](functionality.md) preserves stable requirement IDs.

| Topic | Decision |
|---|---|
| Dashboard | My Fleet + My Incidents + globe, all assigned objects listed with positions and freshness |
| Demo identities | Two required users, optional third, based in Russia, the US and China; four assigned spacecraft each. Assignments are simulated; country is not authorization |
| Run Scan | Server-resolved assigned fleet versus every other usable object in the pinned catalog, next 72 hours; explicit progress and coverage |
| Priority | Severity first, then earliest closest approach. Missing/stale evidence in a separate visible review section. No Pc/time score |
| TCA | Time of Closest Approach; display "Time until closest approach" / "До ближайшего сближения" |
| Proposals | Up to four computed candidates. Show fewer if fewer exist |
| Selection | Shared selected candidate, separate from each human's Approve. Selecting an alternative is not a counter |
| Counter | Ordinary text/voice discussion, not an approval state or structured form |
| Two active operators | Both assigned sides approve the same current selection generation, proposal and revision |
| Confirmed debris | One real active-object operator approves; never fabricate debris approval. An absent active operator is not debris |
| Completion | Scheduled is distinct from observed execution. Historical verification is explicitly replay |

## Data modes: latest user decision

**Dev on:** retain the existing CelesTrak TLE catalog and synthetic event/agent scenarios for UI development and demos. Real catalog elements and synthetic encounter evidence must be distinguished.

**Dev off:** the real mode requires OMM from the backend. It never calls the development `/api/catalog` TLE loader and never substitutes synthetic incidents. Current Phase 1 `catalog.snapshot` returns `ommUrl: null`, so the UI shows "waiting for OMM". The real OMM loader/worker/renderer integration is still pending; a non-null URL alone must not be presented as completed rendering. Current code reports that integration state explicitly.

Both modes live in both Git branches. `main` is a branch, not a runtime switch. CelesTrak remains the source in either format. OMM supports larger catalog IDs and structured exchange, but changing serialization alone does not guarantee better orbit accuracy. See [CelesTrak's format documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php).

## Implemented versus pending

| Implemented Phase 1 | Accepted target still pending |
|---|---|
| Normalized snapshots, spaceObjects, events and agentRuns | Users, fleet assignments and assignment-authorized subscriptions |
| Pinned SOCRATES snapshot and catalog-pair ingestion | Assigned-fleet-versus-catalog scan jobs and coverage/progress |
| Catalog snapshot/pairs and checked Analyst summary queries | Real OMM ingest, catalog payload, frontend parser and propagation worker |
| Public catalog inspection, current coloring and Analyst runtime | Fleet-scoped personal queues, selected severity/time ordering and review sections |
| Frontend Dev switch, simulator, Convex bridge and error boundaries | Authenticated rooms, candidate revisions, selection generation, approvals and unilateral debris |
| Mocked-model tests and backend CI | Shared-deployment/live-provider smoke test, scheduling, verification and reports |

The Phase 1 public catalog queries are not the private assigned-fleet application. Do not add private policy or approval writes to these unauthenticated endpoints. New real-mode work must follow the assignment/identity rules in the specification.

## Integration order

1. Backend: publish a versioned OMM snapshot with full object IDs, epochs, source metadata and a retrievable payload. Update `catalog.snapshot`, whose current validator explicitly permits only null `ommUrl`.
2. Frontend: implement and validate the agreed OMM payload parser and worker propagation without converting OMM back into legacy TLE. Use stable object IDs and the same snapshot as screening. Until this works, keep the explicit real-mode pending state.
3. Implement assignments and `users.me` / `fleet.listMine`, then `scans.startMine` / `scans.getMine`, `events.myQueue` and `events.orbits`. The new signatures are target APIs, not currently deployed functions.
4. Implement shared candidate selection and workflow-specific current approvals, with privacy, re-screening and idempotent scheduling. Keep simulator states distinct from live evidence.

See [Kostya's implementation history](kostya/phase1/plan.md) and [Andrew's runtime guide](phase1-andrew.md) for existing code. The latest workflow/mode decisions above supersede their old global-queue or real-mode TLE fallback descriptions.

## Local validation and deployment

Root backend: `npm ci`, then `npm run check`. Frontend: `cd web`, `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

Frontend backend access requires `NEXT_PUBLIC_CONVEX_URL`. Live Analyst execution requires the model/provider settings in the Phase 1 guide. Repository synchronization does not deploy Convex or supply credentials. No live model call or cloud deployment is claimed by local tests.

Validation for this reconciliation: backend TypeScript and 58 tests passed; frontend TypeScript, ESLint and production build passed. Browser smoke test: real mode made no TLE request; Dev on loaded 18,588 cached catalog objects; switching Dev off cleared the catalog and returned to the explicit OMM waiting state without another TLE request. Build warnings remain for multiple lockfiles and weather-cache filesystem tracing. Live Convex/provider configuration was not tested.
