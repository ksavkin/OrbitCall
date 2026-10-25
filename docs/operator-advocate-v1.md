# Phase 1 stretch: private policies and Operator Advocate v1

Andrew's stretch task from [issue #1](https://github.com/ksavkin/OrbitCall/issues/1) adds company policies and a bounded negotiation round between two Operator Advocates. It builds on the normalized Phase 1 schema. It evaluates supplied candidates; it does not calculate orbits, generate maneuvers, select a proposal, approve anything or schedule a burn.

## Behavior

Each company has a private per-satellite policy using `SatellitePolicy` from the specification: fuel reserve/current fuel, dry mass, specific impulse, protected and preferred windows, acceptable probability and mission priority. Contact details and language stay outside this policy. `policies.getMine` and `policies.update` resolve the company from a verified identity; clients never supply a company ID.

Candidate publication starts a bounded round: Advocate A evaluates its policy and makes a recommendation; Advocate B reads A's checked outcomes/categories and responds using B's own policy. Each side makes a separate Claude call. If A fails, B can still evaluate its own constraints; when A later succeeds, any earlier or in-flight B response is superseded and B responds again using A's new outcomes. This also handles overlapping round starts. A subsequent candidate revision or policy change invalidates both results and starts a fresh round. Model calls do not loop until agreement. An unavailable model leaves a failed run that the assigned operator can retry.

Deterministic code enforces the policy before and during publication:

| Evidence or constraint | Result |
|---|---|
| Estimated burn fuel leaves less than the reserve | `infeasible`, category `fuel`, for the moving operator |
| Fuel estimate is unavailable | `pending`, category `fuel`; no estimate is fabricated |
| Burn instant is inside a protected window | `infeasible`, category `mission_window`; windows are start-inclusive/end-exclusive |
| Burn is inside a preferred window | A private preference score helps ranking; it cannot override a hard limit |
| High mission priority | A preference to preserve that company's mission; it cannot override another constraint |
| Waiting exceeds the supplied-probability threshold | `infeasible`, category `risk` |
| Waiting has no supplied probability | `pending`, category `risk` |
| Maneuver has only indicative geometry | `pending`, category `risk`: increased separation does not prove post-maneuver probability |
| A maneuver has missing or non-improving separation | Also `pending`, category `other` |
| Own-satellite policy is missing | `pending`, category `other`, with no model recommendation permitted |
| Burn time or closest approach has passed at evaluation | `infeasible`, category `other` |

An Advocate can recommend a pending candidate **for human review**, but it remains pending. `preferred` is used only for a recommended candidate that has no unresolved checks. The second Advocate cannot recommend a candidate the first has explicitly rejected. `mutuallyAcceptable` contains only candidates both sides mark feasible/preferred; `reviewCandidates` can also contain pending candidates. Empty intersections remain explicit. Even a jointly feasible waiting option still requires the later human decision workflow.

The current candidate contract specifies an instantaneous burn. It does not verify a burn duration against a window. Supplied fuel costs are checked; the Advocate does not derive new fuel costs from mass/ISP or invent a post-maneuver Pc.

## Privacy and access

- Raw policies are stored in `policies`. An action reads only the policy of the company it represents. The counterpart enters its prompt as checked candidate IDs, outcomes, categories and recommendations.
- The model can return only `{ "preferredCandidateId": "P2" }` or a null recommendation. Unknown IDs, rejected candidates, extra properties and arbitrary prose are rejected. All shared outcomes and categories come from deterministic checks, never private model explanations.
- `advocateContexts` stores private references to the policy revision and candidate generation used by a run. No public query reads that table. `agentRuns` stores progress and version references, with no policy values or model response text from Advocates.
- `negotiationMessages` stores only checked assessments or policy-change categories. It is the shared record, not a raw model transcript. Old assessments remain historical and are marked `current: false`.
- `advocates.list` and `advocates.rerun` require an operator in a party company **and a current fleet assignment to that side's object**. Removing the assignment immediately removes access. Company membership or country alone grants no incident access.
- Policy reads/edits require role `operator` and operate only on that company's owned satellites. A company operator can manage its company policy independently of incident assignment. `head_of_ops` receives no policy or negotiation access through these endpoints.

The public Phase 1 catalog/Analyst endpoints remain public catalog endpoints and never return policies or private Advocate context. Auth0 login integration remains separate work. The new endpoints use the verified identity's `tokenIdentifier` (issuer plus subject), provisioned through a trusted internal function; this is the implemented account lookup key for the stretch endpoints. A browser cannot provision itself or claim spacecraft.

## Data and integration seams

Andrew's added tables remain in `convex/schema/agents.ts`; Kostya's normalized catalog/event tables are unchanged.

| Table | Stores |
|---|---|
| `companies`, `users` | Trusted company identity and account membership |
| `satelliteOwners`, `fleetAssignments` | Company ownership and explicit per-user responsibility |
| `policies` | Current company policy and revision |
| `candidateRevisions` | One immutable copy of each supplied candidate revision |
| `candidateSets` | References to the current revisions, evidence generation, two participating companies and review state |
| `advocateContexts` | Private references binding an attempt to its policy/candidate revisions |
| `negotiationMessages` | Shareable assessments and category-only change history |

`agentRuns` is extended with an optional role and company. Existing rows without a role are treated as Analyst runs. Working/stalled flags include all active roles, while Analyst summary reads and attempt numbering remain restricted to Analyst runs.

### Trusted backend calls

1. `internal.operators.provision({ key, name, simulated, objectIds, members })` registers an existing object's company and accounts. A member is `{ tokenIdentifier, role, assignedObjectIds }`. Assignments are explicit and must belong to the registered company. Re-provisioning an existing member replaces that member's active assignments; it does not transfer users or satellites between companies.
2. `internal.candidates.publish({ eventId, baseVersion, candidates, start? })` publishes up to four supplied candidates. Use `baseVersion: null` initially and the current version thereafter. Each candidate follows `convex/lib/policyValidators.ts`, with a stable `candidateId` and integer revision. Same-revision changes and rollback are rejected; candidate records remain immutable even when removed from the current set. These v1 IDs are local to the event and are not yet the full Phase 2 `Id<"proposals">` contract.
3. Publication normally schedules `internal.agents.advocate.negotiate({ eventId })`, which starts A. A's finish/failure transaction schedules B once. The internal option `start: false` is for seeding without a model call. `internal.agents.advocate.start({ eventId, side })` starts the named side and deduplicates an identical active/completed attempt; completing A also schedules B. A failed B response requires an explicit B retry and never restarts A.

The event must have two distinct registered companies. Missing active operators are not treated as debris, and the backend never fabricates a second operator. Unilateral debris, same-company internal decisions, complete room selection/approval and discussion-driven candidate generation remain subsequent workflow work.

### Frontend calls

| Function | Result |
|---|---|
| `policies.getMine({})` | `{ satellites, revision, updatedAt, simulated }`; an unconfigured policy returns an empty array and revision zero |
| `policies.update({ satellites })` | `null`; validates ownership, finite values and UTC windows, then invalidates affected results |
| `advocates.list({ eventId })` | Candidate set version/state, simulation label, current A/B assessments, `mutuallyAcceptable`, `reviewCandidates`, `situation`, working/stalled flags, sanitized run status/errors for each side and up to fifty historical messages |
| `advocates.rerun({ eventId })` | `null`; retries the caller's assigned side for failed/stalled work with current open candidate evidence; a successful A retry also refreshes B's response |

The `situation` values are `awaiting_advocates`, `needs_operator_decision`, `needs_more_data`, `no_mutually_acceptable_option`, `no_candidates`, `stale_candidates`, and `scheduled_review_required`. An empty supplied candidate set is explicit and makes no model calls. These describe the v1 evaluation; they do not replace the room lifecycle statuses in the full specification. Translated UI text, group-room membership, chat subscriptions and rendering these results remain frontend integration work. The latest [master roadmap](master-roadmap.md) retains pair-specific decisions within group rooms; this v1 evaluates one pair event at a time.

## Changes, retries and scheduling boundary

Policy updates supersede both sides' current assessments so neither can rely on an old counterpart result. They publish only changed categories such as `fuel`; values and mission-window reasons never enter shared history. An identical policy update causes no extra model requests. Updating policy for a scheduled candidate set only marks `reviewRequired`; it does not replace revisions or call the agents. Closed cases are retained without restarting work.

Candidate publication likewise supersedes old assessments. Finish-time checks verify the current candidate-set version, evidence, own-policy revision and latest run, then recompute the constraints before writing the shared result. Concurrent duplicate starts are deduplicated. A late result cannot replace the retry or publish for obsolete evidence. The existing 60-second stall watchdog and sanitized error handling apply to both Advocates.

The later scheduler must keep `candidateSets.state` synchronized with the actual open/scheduled/closed workflow. The `scheduled` state exercised here is a review boundary, not an implementation of scheduling. Full approval invalidation, assignment-revocation effects on approvals, selection generations and authorized schedule writes remain the Phase 2/3 integration. No current endpoint creates approvals or schedules.

## Run the synthetic fixture

Install the root package with `npm ci`, then run `npm run check`. Automated tests use a fixed clock and mocked Claude responses; no keys are required.

The branch has been connected to Andrew's development deployment in the existing OrbitCall project. The shared production deployment remains the team's integration target after review. Start/update your selected development backend with `npx convex dev`, then:

```sh
npx convex env set ENABLE_DEV_FIXTURES true
npx convex run dev:seedAdvocates '{}'
```

This seeds two fictional spacecraft (`SIM-1001`, `SIM-1002`), companies, policies, fixture accounts/assignments and four candidates. It makes no model requests. Repeating it preserves later policy edits and assignment revocations. It is a focused backend fixture, not the planned four-spacecraft-per-user product demo. Times are pinned to October 24–25, 2026; tests freeze their clock. Past burns are rejected in a live run, so future rehearsals need fresh fixture times.

Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` on that deployment for live calls, then use the returned event ID:

```sh
npx convex run agents/advocate:negotiate '{"eventId":"EVENT_ID"}'
npx convex run advocates:list '{"eventId":"EVENT_ID"}' --identity '{"tokenIdentifier":"https://orbitcall-fixtures.invalid|operator-a"}'
```

The CLI identity flag uses your privileged developer access for a fixture check; it is not a browser login mechanism. The fixture's invalid-domain identities do not make publicly usable accounts. Without model settings the run records `MODEL_NOT_CONFIGURED`, publishes no assessment and clears working state. After configuring a model, invoking `negotiate` again retries a failed A and schedules B. If only B failed, retry it with `agents/advocate:start` and `{ "eventId": "EVENT_ID", "side": "B" }`, or the assigned operator's `advocates.rerun`. The fixture normally leaves P2 as a provisional shared review option; it does not claim a jointly approved maneuver.

Verification covers policy ownership and assignment revocation, isolated prompts and shared output, hard limits versus preferences, incomplete evidence, immutable revisions, policy/data changes during a run, scheduled review, retries/stalls, model-output rejection and compatibility with existing Analyst/catalog behavior. Live-provider success must be recorded separately from the mocked tests.

Validation recorded for this change: the initial implementation passed strict TypeScript checking and 93 tests and was deployed with the synthetic fixture to Andrew's OrbitCall development deployment. A real cloud action run with missing model settings recorded `MODEL_NOT_CONFIGURED` for both sides, cleared working state and published no assessment; the authorized fixture read succeeded. After integrating the latest OMM baseline, the merge review passes strict TypeScript checking and 97 tests, including A recovering after B responded, late B results, and explicit retries after B fails. The review changes have not been deployed to Convex. Live Claude responses remain unverified until the deployment's model settings are supplied.
