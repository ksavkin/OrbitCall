# Andrew's Phase 1: Incident Analyst

Source of truth for current scope and stack: [master roadmap v1.1](master-roadmap.md). Claude retains the Analyst and private Advocates, Gemini runs the Coordination Host, and Grok runs independent checking. This document records the earlier Analyst implementation and does not establish completion of those later roles.

> Current product decisions: [assigned-fleet workflow](user-flow.md) and [integration handoff](integration-status.md). Dev on is TLE/simulation; Dev off requires OMM and has no TLE fallback. The old Phase 1 fallback/global-queue descriptions below are implementation history, not the latest real-mode contract. Fleet scope, new sorting, selection/approval and unilateral debris are accepted follow-up requirements.


This implements Andrew's five required tasks from [roadmap issue #1](https://github.com/ksavkin/OrbitCall/issues/1). The initial scaffold commit contains an empty `agents.analyst.start({ eventId })`; the following implementation retains that entry point. Operator policies and the Operator Advocate are excluded, as requested. The issue's assignments and feature-branch/PR workflow supersede the original staffing and single-main-branch plan in `plan-v1.md`.

## What is implemented

| Required task | Implementation |
|---|---|
| Stable empty entry point first | Initial scaffold commit, followed by `convex/agents/analyst.ts` |
| Agent runtime and working/stalled state | `convex/agentRuns.ts`, `convex/lib/claude.ts`, `convex/schema/agents.ts` |
| Five-line Incident Analyst summary | `convex/lib/analyst.ts`; the checked templates are kept on the run (`agentRuns.checkedOutput`) and rendered against the event's current facts |
| Every number matches the evidence | Field-bound templates, authoritative value substitution, validation repeated inside the publishing transaction |
| Test event and candidates | `fixtures/events.ts`, `fixtures/candidates.ts` |

The schema is split as requested: `convex/schema/data.ts` holds Kostya's normalized tables (`snapshots`, `spaceObjects`, `events`); `convex/schema/agents.ts` holds Andrew's `agentRuns`; `convex/schema.ts` combines them. Tables store only what a query cannot derive, and only what Phase 1 uses; `convex/lib/events.ts` assembles the analyst's `EventFacts` from them. There are no identity tables until sign-in in Phase 2. The public event response will also need computed fields such as `mySide` and later room/proposal state from the full specification.

The frontend is still its existing implementation. This change supplies a backend query for Adil to connect; it does not replace the frontend's mock engine or implement catalog ingestion. Completion of the whole Phase 1 still requires Kostya's real catalog and event data, frontend wiring, a successful live Claude run and merging the reviewed changes into `main`.

## Local checks without accounts

Use a recent supported Node.js version (22 or newer) and npm. The root backend package and `web/` frontend package install independently.

```sh
npm ci
npm run check
```

`check` runs strict TypeScript checking and the test suite. The tests use `convex-test`, a fixed clock and simulated evidence. They exercise the Convex action/mutation/query flow with Claude mocked, and exercise the real Anthropic SDK against a mocked HTTP response. No paid model request is made by the tests.

Coverage includes five-line output, altered numbers/units/identifiers/times, missing versus zero probability, maximum probability labels, source disagreement, duplicate starts, stale results, failure/retry, stalled runs, ingestion scheduling and pair deduplication, public summary reads, internal retries, provider error sanitization and disabled automatic HTTP retries.

## Run with Convex

```sh
npm run dev
```

For development without an account, choose the CLI's local setup. For the shared project, sign in with `npx convex login`, then use `npx convex dev --configure existing` and select the team's **OrbitCall** project and a development deployment. If a local development server is already running, stop it before reconfiguring. Do not create a second project with the same name. A missing OrbitCall entry means this account needs access from its project owner.

The CLI writes local connection settings to the ignored `.env.local`. Local deployment state is also ignored. Generated Convex API/types are committed so that the caller builds before connecting to a deployment. Regenerate after adding exported functions with `npx convex codegen` while the selected deployment is available.

Configure these **on the selected Convex development deployment**:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key; set it in Convex dashboard settings, never in Git or a frontend environment variable |
| `ANTHROPIC_MODEL` | An exact Claude model ID available to the team's Anthropic account; there is intentionally no guessed default |
| `ENABLE_DEV_FIXTURES` | Set to `true` only when using the explicit development seeding command below |

The browser only needs the deployment's public Convex URL when it is wired. Copying `.env.example` does not configure the Convex server's environment. Never put the Anthropic key in `NEXT_PUBLIC_*`.

### Fixture walkthrough

With `npm run dev` running, open another terminal at the repository root:

```sh
npx convex env set ENABLE_DEV_FIXTURES true
npx convex run dev:seed '{}'
```

Copy the returned event ID into these two commands:

```sh
npx convex run agents/analyst:start '{"eventId":"REPLACE_WITH_RETURNED_ID"}'
npx convex run agentRuns:inspect '{"eventId":"REPLACE_WITH_RETURNED_ID"}'
```

Seeding is internal and opt-in. All scenarios share one encounter, so seeding a scenario switches that event to it. It does not automatically call Claude. Alternate scenarios are `{"scenario":"missing_pc"}` and `{"scenario":"missing_metadata"}`. The fixture timestamps are pinned to October 24–25, 2026 for reproducible tests; seeding preserves those values even after that date. Its stored red label is a fixture property. Live ingestion always calculates the threshold against the current time.

With a valid key and model, inspection should show `status: "succeeded"`, five summary lines, and both working/stalled flags false. This is the command sequence for the live smoke test. Without settings, the run ends as `failed` with `MODEL_NOT_CONFIGURED`, publishes no summary and clears the working flag. Always inspect the record: the action catches model failures to record them, so a successful CLI command by itself does not prove a model call succeeded. After fixing configuration, invoking the internal start function again retries a failed attempt. An already successful attempt for the same evidence is deduplicated.

All fixture evidence is synthetic, including the encounter with reference catalog identifier `25544`. It is not a measured close approach. The candidate values are fictional inputs, carry `simulated`/`indicative` labels and do not authorize or schedule any maneuver.

## Kostya's event integration

`events.ingest` is an internal mutation that stores one encounter from a registered snapshot; it fetches no catalog data itself. Arguments: `{ snapshotId, objectA, objectB, tcaUtc, missKm, relSpeedKmS, pcValue, simulated }`, where each object is `{ objectId, name, country, launchDate }`. `pcValue` is `null` when unavailable, never zero. The Pc metric, source, epoch and URL are not arguments: they follow from `simulated` (SOCRATES `max_prob` for real pairs) and from the snapshot's `sources`.

The same object pair within ±60 s of TCA is the same event, so a reload keeps its `_id`. Objects are stored once by `objectId`; real catalog metadata updates them, fixtures never overwrite them. Ingest computes the color, schedules the Analyst for newly red or changed red evidence, and supersedes running work based on old evidence. A red event has supplied probability strictly above `1e-4` and a TCA strictly in the future and less than 72 hours away. Re-importing identical evidence does not make another model call and does not move `updatedAt`. The evidence key includes the snapshot's source metadata shown in the summary, including fetch times; register a new snapshot only when new source evidence was actually fetched.

## Adil's summary integration

Subscribe to `api.agentSummaries.get({ eventId })` for an event without opening a decision room. It returns:

```ts
{
  eventId,
  summaryLines: string[],      // exactly five, or [] until current checked output exists
  numbersChecked: boolean,
  originalLang: "en",          // translation is a later phase
  createdAt: string | null,    // ISO UTC
  simulated: boolean,
  agentsWorking: boolean,
  agentsStalled: boolean,
  run: null | {
    status: "running" | "succeeded" | "failed" | "superseded",
    stage: string,
    attempt: number,
    startedAt: string,
    lastProgressAt: string,
    errorCode: string | null,
    errorMessage: string | null
  }
}
```

Old summaries and run status are hidden when their evidence key no longer matches the current event. Run input snapshots, raw model output and evidence keys are never returned to the browser. `agentsWorking` stays true while any run is active; after 60 seconds without progress, `agentsStalled` also becomes true. A stalled call may still finish safely; retry supersedes it so that it cannot overwrite the replacement. Finishing or failing clears its active state.

`internal.agents.rerun({ eventId })` retries a failed or stalled Analyst; it stays internal until sign-in, so the browser cannot trigger model calls. It refuses an actively progressing or already successful run. It does not modify the event's decision status, approvals, proposals or schedules.

Phase 1 events are public catalog data, so `agentSummaries.get` needs no sign-in (plan D3). Identity and party checks arrive with sign-in in Phase 2.

## Summary and number-check behavior

The five lines cover:

1. Both objects and their exact identifiers.
2. TCA, miss distance and relative speed with units.
3. Supplied probability, its metric/source/epoch, or an explicit unavailable message.
4. Source epochs/fetch times and the GP/SupGP disagreement when both distances exist.
5. A statement limiting the summary to evidence, including an explicit simulated-incident label when applicable.

The model receives only a projection of public evidence and a small set of allowed wording templates. It selects one exact template per line. Code fills the placeholders from the captured input. The validator rejects added prose, changed placeholders, invented values, swapped fields, changed units, wrong ordering and the wrong number of lines. Publication repeats the validation in the database transaction, and succeeds only for the current attempt and current evidence. This first version intentionally constrains the model's prose rather than accepting arbitrary explanations with a loose numeric-token scan.

Each accepted attempt makes one Claude Messages request, with a 90-second timeout and SDK automatic retries disabled. The runtime records model ID, token usage, progress times, attempt number and a sanitized failure. Failed attempts can be retried explicitly; an identical running or completed attempt is not duplicated. Phase 1 implements only the Incident Analyst call. No private policy is included in its model context.

## Validation recorded for this change

- TypeScript checking and the automated tests pass locally; provider responses in tests are mocked.
- The actual local Convex server accepts the schema and functions.
- A seeded event can invoke the actual local action; absent model configuration produces a recorded failure and no unchecked summary.
- A live Claude success and the shared OrbitCall deployment require the team's account access and model settings. They must be verified separately before treating this as the complete shared Phase 1 demo.
