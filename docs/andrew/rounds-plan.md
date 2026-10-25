# Andrew: agent work for issue #6

Source of truth: [master roadmap v1.1](../master-roadmap.md) and [issue #6](https://github.com/ksavkin/OrbitCall/issues/6). This file turns Andrew's bullets into one brief per agent. Each brief lists the files the agent may touch, the interface it must produce for later rounds, the tests, and when the task counts as done.

Round 1 contracts are written out in full because Kostya and Adil build against them in parallel. Round 2 and 3 briefs name their inputs, because those depend on code that has not landed yet. Each agent writes its own tests first (TDD) inside its brief.

## How every task runs

- One agent per bullet, one branch per bullet, cut from current `origin/main`: `andrew-r1-host-checker`, `andrew-r1-candidate-cards`, `andrew-r1-memory-note`, `andrew-r2-publish-candidates`, `andrew-r2-host-trigger`, `andrew-r2-history`, `andrew-r3-advocate-memory`, `andrew-r3-host-speech`.
- Use a separate git worktree per agent so parallel agents never share a checkout.
- Never commit `convex/_generated/`, `package.json`, or a lockfile. Run `npx convex codegen` locally so types resolve, then leave `_generated/` unstaged.
- Never edit `convex/schema.ts` or `convex/schema/*`. Tables come only from the voice backend task (round 1) and the schema task (round 1.5).
- Done means `npm run check` passes (typecheck plus vitest, including the existing `tests/advocates.test.ts`), the commits are small and imperative per `AGENTS.md`, and the branch is pushed for review.
- A model or provider failure never writes an approval, never selects a card, and never substitutes another provider silently (§6, §11).

## Step 0: before any agent starts

- [x] `git pull` on `main`.
- [x] Round 0 landed in `e2c5502` (done by Andrew): root `@google/genai`, `pg`, `@types/pg`, `livekit-server-sdk`; web `livekit-client`. Backboard uses `fetch`, with no SDK.
- [x] Dev deployment `posh-crane-978` has `ANTHROPIC_*`, `GEMINI_API_KEY`, `GEMINI_HOST_MODEL=gemini-3.8-flash`, `XAI_API_KEY`, `XAI_CHECKER_MODEL=grok-4.20-0309-reasoning`. Backboard and Tiger keys are needed from round 2.
- [x] Post the schema request below as a comment on #6. The schema task freezes `convex/schema.ts` for the rest of the project, and it starts as soon as the voice backend lands, possibly before any of Andrew's round 1 work merges.

### Schema request for the round 1.5 task (post on #6)

1. **Host runs** (`hostRuns`): `roomId`, `trigger` (`final_message | candidates_changed | summary_requested | call_ended`), `inputVersion`, `status` (`running | succeeded | failed | superseded`), `span` (the `AgentSpan` below), `output` (the checked `HostOutput` or null), `check` (`{ span, agrees, reason, flaggedIds }` or null), `attempt`. Unique-ish index on `["roomId", "inputVersion", "trigger"]`, plus `["roomId"]` for the trace panel.
2. **Observation exports** (`observationExports`): `observationKey` (unique, includes the observation time), `eventId`, `runId` (demo run or null), `observedAt`, `source`, `metric`, `value` (nullable), `evidenceVersion`, `simulated`, `exportState` (`pending | exported | failed`), `attempts`. Index by `observationKey` and by `eventId`.
3. **History cache**: `history.series` must read a versioned cache. Either a separate `historySeries` table (`eventId`, `seriesVersion`, `points`, `stale`, `fetchedAt`, `simulated`) or explicit cache fields on observation exports. The list in #6 has no cache table, so the schema task needs to choose one.
4. **Backboard assistants**: one memory assistant per company per demo run (§10). It needs a stored `{ companyId, demoRunId, assistantId, closedAt }`, either on demo runs or in its own table. Demo reset (Kostya, round 2) also needs it to close the namespace.
5. **Debris advocate (blocking)**: `candidateSets.companyBId` is required today, and `candidates.publish` rejects an event without two distinct owners. #6 forbids rewriting `candidateSets`, but round 2 requires "debris: one advocate, no side B". Proposed fix: let the schema task widen `companyBId` to `v.union(v.id("companies"), v.null())`. Existing rows stay valid. Also add `convex/candidates.ts` to the round 2 publish task's file list. Alternative: debris candidates live only in the new proposals table and skip the advocate tables. Kostya should decide this before 1.5 lands.

### Scope gaps to raise on #6 now

- **Round 3 advocate memory** is limited to `convex/advocates.ts`. Backboard recall is an external call, and the prompt is built in `convex/agents/advocate.ts` (the action) and `convex/lib/advocate.ts`. Neither is in the allowed list, and nobody else owns them. Ask to add both files to that bullet.
- **History export trigger**: "a committed observation schedules an export" needs a caller. Ingestion (`convex/ingest.ts`) and scans (`convex/scans.ts`) are Kostya's files. Ask for a round 3 line in which Kostya's scan or ingest commit calls `internal.history.recordObservation`.
- **Host speech in round 3** depends on whatever `convex/call/` exposes after the voice backend lands. If it has no internal entry point that accepts canonical host text for translation and TTS, raise that in round 2 so Kostya can add one.

## Round 1 (starts after Round 0)

The three bullets share no file. None reads a new table, because the schema task has not landed yet.

### R1-A: Coordination Host and Grok checker

Branch `andrew-r1-host-checker`. Phases 6 and 7; Gemini and Grok sponsor evidence.

**Files**
- Create: `convex/lib/host.ts`: pure code (no `"use node"`). Context type, prompt, JSON schema, output checker.
- Create: `convex/lib/checker.ts`: pure code. Checker input, prompt, JSON schema, result parser.
- Create: `convex/coordinationHost.ts`: `"use node"`. Gemini call through `@google/genai`, plus internal action `run`.
- Create: `convex/rationaleCheck.ts`: `"use node"`. xAI chat completions call through `fetch`, plus internal action `run`.
- Create: `tests/host.test.ts`, `tests/checker.test.ts`.
- Do not touch: `services/`, `convex/call/`, `convex/schema*`, `convex/_generated/`, package files.

**Produces** (Round 2 `hostTriggers` and Adil's host trace read these exact names):

```ts
// convex/lib/host.ts
export type HostTrigger = "final_message" | "candidates_changed" | "summary_requested" | "call_ended";
export type Language = "en" | "ru" | "zh";

export interface AgentSpan {
  role: "coordination_host" | "rationale_check";
  provider: "google" | "xai";
  model: string;
  inputVersion: string;
  attempt: number;
  startedAt: number;
  finishedAt: number;
  status: "succeeded" | "failed";
  usage: { inputTokens: number; outputTokens: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
}

// Allowlisted shared context only: no private policy, no Backboard memory (§6 host contract).
export interface HostContext {
  roomId: string;
  inputVersion: string;
  trigger: HostTrigger;
  members: { companyId: string; language: Language }[];
  events: {
    eventId: string;
    objectAId: string;
    objectBId: string;
    debris: boolean;
    tcaUtc: string;
    missKm: number;
    simulated: boolean;
    candidates: { candidateId: string; revision: number; label: string; kind: "maneuver" | "wait";
      movingObjectId: string | null; burnTimeUtc: string | null; deltaVMs: number | null; missAfterKm: number | null }[];
    feasibility: { companyId: string; candidateId: string; revision: number;
      outcome: "feasible" | "infeasible" | "preferred" | "pending"; categories: string[] }[];
    approvals: { companyId: string; candidateId: string; revision: number }[];
  }[];
  messages: { messageId: string; companyId: string; language: Language; text: string; createdAt: string }[];
}

export interface HostOutput {
  inputVersion: string;
  clarifications: { question: string; eventId: string | null; messageIds: string[] }[];
  requestedRevisions: { eventId: string; candidateId: string; reason: string; messageIds: string[] }[];
  summaries: { eventId: string; text: string; messageIds: string[] }[];
}

export const hostResponseSchema: object;                       // JSON Schema for HostOutput
export function hostPrompt(context: HostContext): { system: string; user: string };
export function checkHostOutput(raw: string, context: HostContext): HostOutput; // throws AnalystError
```

```ts
// convex/lib/checker.ts
export interface CheckInput {
  inputVersion: string;
  candidates: HostContext["events"][number]["candidates"];
  explanation: string; // the text being checked, e.g. a host summary
}
export interface CheckResult { agrees: boolean; reason: string; flaggedCandidateIds: string[] }
export const checkResponseSchema: object;
export function checkPrompt(input: CheckInput): { system: string; user: string };
export function parseCheck(raw: string, input: CheckInput): CheckResult; // throws AnalystError
```

```ts
// convex/coordinationHost.ts  ("use node")
export async function callGemini(prompt: { system: string; user: string }): Promise<{ raw: string; model: string; usage: AgentSpan["usage"] }>;
export const run: InternalAction<{ context: HostContext; attempt: number }, { span: AgentSpan; output: HostOutput | null }>;

// convex/rationaleCheck.ts  ("use node")
export async function callGrok(prompt: { system: string; user: string }): Promise<{ raw: string; model: string; usage: AgentSpan["usage"] }>;
export const run: InternalAction<{ input: CheckInput; attempt: number }, { span: AgentSpan; result: CheckResult | null }>;
```

**Rules the tests must pin down**
- Gemini: `ai.models.generateContent({ model: GEMINI_HOST_MODEL, contents, config: { systemInstruction, responseMimeType: "application/json", responseJsonSchema: hostResponseSchema } })`. Missing key or model gives `MODEL_NOT_CONFIGURED`. The SDK is constructed with no automatic retry.
- Grok: `POST https://api.x.ai/v1/chat/completions` with `model: XAI_CHECKER_MODEL` and `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`.
- `checkHostOutput` rejects:
  - extra keys, or an `inputVersion` that differs from the context;
  - an `eventId`, `candidateId`, or `messageId` not present in the context;
  - any number in `question`, `reason`, or `text` that does not appear in the context's event, candidate, or message values (reuse the Analyst's number-check idea from `convex/lib/analyst.ts`);
  - approval language aimed at a person ("approved", "I approve", "authorize");
  - oversized arrays or strings.
- `parseCheck` rejects flagged IDs that are not among the input candidates. A checker disagreement is data. It never throws as a failure.
- `run` never throws. A provider or check failure returns `span.status = "failed"` with the sanitized code and message (copy the `safeFailure` pattern from `convex/lib/claude.ts`; never persist a raw provider error) and `output: null`.
- No database writes, no new table. The span is the return value.

**Tests** (stub `fetch` exactly as `tests/claude.test.ts` does):
- Exactly one request, with the right URL, model, schema, and system/user split.
- Happy path returns `status: "succeeded"`, usage, and the checked output.
- Unknown message ID, invented number, approval phrase, and stale `inputVersion` each give `CONSTRAINT_CHECK_FAILED` or `INVALID_OUTPUT`.
- HTTP 401, 429, and 503 each make one call and return a failed span that does not contain the raw provider message.
- A context containing a private-looking field is rejected at the type boundary. Keep `HostContext` an exact allowlist.

**Demonstrate before ticking anything**: with dev env set, run `npx convex run coordinationHost:run '<fixture context JSON>'` and `npx convex run rationaleCheck:run ...` once each. Save the returned spans (model, tokens, and output) as Gemini and Grok evidence for §10 and §14.

### R1-B: Candidate cards

Branch `andrew-r1-candidate-cards`. Phase 6.

**Files**: create `convex/lib/candidateCards.ts` and `tests/candidateCards.test.ts`. Do not edit `convex/advocates.ts`, `convex/candidates.ts`, or `convex/lib/orbitClient.ts` (Kostya builds that in parallel).

**Input contract**: before writing code, get the `/candidates` response model from Kostya's orbit service source (the pydantic model he is copying into `services/orbit/`). Mirror it as `OrbitCandidatesResponse` in this file. In round 2 the publish task checks that it matches `orbitClient.ts`.

**Produces**:

```ts
export interface CardContext {
  facts: EventFacts;                  // from convex/lib/analyst.ts
  activeSide: Side;                   // the side whose operator acts
  counterpartSide: Side | null;       // null for debris
  previous: Candidate[];              // last published revisions, for revision bumping
  nowMs: number;
}
export function mapCandidates(response: OrbitCandidatesResponse, context: CardContext): Candidate[];
export function stableCandidateId(c: { kind: "maneuver" | "wait"; movingObjectId: string | null;
  burnTimeUtc: string | null; direction: string | null; deltaVMs: number | null }): string;
```

**Rules and tests**:
- Output passes the existing `validateCandidates(candidates, facts)` unchanged: at most four cards, `missBeforeKm === facts.missKm`, `indicative: true`, burn before TCA, wait cards with a review condition.
- Drop burn times already in the past. Never pad to four. Include a wait card only if the service returned one.
- IDs are deterministic, so the same geometry gives the same ID. Revision stays the same when content is unchanged and becomes `previous.revision + 1` when it changed.
- `simulated` follows `facts.simulated` and the service flag. A simulated event never yields an unlabeled card.
- **Debris**: `counterpartSide === null` means every maneuver moves the active side. The function produces no B-side card and no invented second operator, and a debris object as `movingObjectId` is rejected.
- Never attach the event's Pc to a card as a post-maneuver probability.

### R1-C: Memory note

Branch `andrew-r1-memory-note`. Phase 10; Backboard.

**Files**: create `convex/lib/advocateMemory.ts` and `tests/advocateMemory.test.ts`. Pure code: no Backboard call here, since Kostya's `convex/lib/backboard.ts` lands in parallel.

Round 3 may only edit `convex/advocates.ts`, so everything the round 3 task needs (the read note *and* the write item) must land in this file now.

**Produces**:

```ts
export interface MemoryEntry { memoryId: string; text: string; companyId: string;
  sourceEventId: string; sourceMessageIds: string[]; createdAt: string }
export type MemoryRecall = { status: "available"; entries: MemoryEntry[] } | { status: "unavailable"; reason: string };

export interface MemoryNote {
  status: "used" | "none" | "unavailable";
  quotes: { memoryId: string; text: string; sourceEventId: string; sourceMessageIds: string[] }[];
  promptBlock: string;   // goes only into this company's advocate prompt
  shareable: string;     // "Memory used: ..." / "No relevant memory" / "Memory unavailable"; no private content
}
export function memoryNote(recall: MemoryRecall, companyId: string, limit?: number): MemoryNote;

export interface MemoryItemDraft { companyId: string; demoRunId: string; text: string;
  sourceEventId: string; sourceMessageIds: string[] }
export function buildMemoryItem(input: { companyId: string; demoRunId: string; preference: string;
  sourceEventId: string; sourceMessageIds: string[] }): MemoryItemDraft; // throws if it fails checkMemoryItem
export function checkMemoryItem(item: MemoryItemDraft): void;
```

**Rules and tests**:
- Quote memory text verbatim with its sources. Entries from another `companyId` are dropped, and a test proves it.
- No entries gives `none` and the text "No relevant memory". A failed recall gives `unavailable` and "Memory unavailable" (§11 failure table). Neither case is ever silent.
- **Memory does not approve**: the note feeds only the prompt. Run `evaluateCandidates` and `checkRecommendation` from `convex/lib/advocate.ts` with and without a note and assert identical outcomes. A memory item with approval or authorization language fails `checkMemoryItem`.
- A memory item needs at least one source ID. It must be short (for example 280 characters or fewer), must not mention an approval, and must not contain raw private numbers (fuel kg, protected window times). Current policy outranks memory, and the prompt block says so.
- `shareable` never contains memory text, only the fact that memory was used and the source event ID.

## Round 1.5: no Andrew task

Only follow up on the schema request. Check the landed tables against the fields above before round 2 starts. A missing field cannot be added later.

## Round 2 (starts after round 1 and the schema task are on `main`)

### R2-A: Publish candidates into the advocate tables

Branch `andrew-r2-publish-candidates`. Files: `convex/advocates.ts`, `convex/lib/publishCandidates.ts`, `tests/advocateCandidates.test.ts`, and `convex/candidates.ts` if the debris decision adds it.

- Internal action: `orbitClient.candidates(...)`, then `mapCandidates(...)`, then `internal.candidates.publish`, using the event's current candidate set version as `baseVersion`.
- Check the landed `OrbitCandidatesResponse` against `orbitClient.ts` types. If they differ, fix the mapper here.
- Debris: one advocate run, no side B, no `negotiate` handoff to B. This follows whatever the schema decision allowed.
- Orbit failure leaves the previous candidate set and runs untouched.
- All existing `tests/advocates.test.ts` cases stay green.

### R2-B: Host trigger

Branch `andrew-r2-host-trigger`. Files: `convex/hostTriggers.ts`, `tests/hostTriggers.test.ts`.

- `hostTriggers.request` (internal mutation): `{ roomId, trigger, inputVersion }`. It dedupes on the host runs index `(roomId, inputVersion, trigger)`, so an existing running or succeeded row is a no-op. It inserts a `running` row and schedules the action.
- The action builds `HostContext` by reading the round 1.5 tables directly (rooms, messages, proposals, approvals, advocate shared outcomes). It does not call Kostya's round 2 functions, which land in parallel. Messages written by the host are excluded, so the host never triggers itself.
- It calls `internal.coordinationHost.run`. On success it calls `internal.rationaleCheck.run` on each summary. A finish mutation rechecks that `inputVersion` is still current, then stores the span, checked output, and check result. A stale result is stored as `superseded`, not published.
- Requested revisions are stored as host output only. They go back through candidate calculation and never change proposals directly.
- No subscription to new messages: round 3 connects `messages.send`.
- Bounded retry: one attempt per explicit `request` call, with the attempt number taken from existing rows.

### R2-C: History

Branch `andrew-r2-history`. Files: `convex/history.ts`, `convex/lib/tigerExport.ts`, `tests/history.test.ts`.

- `history.recordObservation` (internal mutation) upserts an `observationExports` row by `observationKey` and schedules the export.
- `tigerExport` uses Kostya's `convex/lib/tiger.ts`. It creates the hypertable if absent and writes with `INSERT ... ON CONFLICT (observation_key, observed_at) DO NOTHING` using parameterized SQL only.
- A refresh action queries Tiger and writes the versioned cache. `history.series({ eventId })` is an authorized query that reads only the cache.
- Real and simulated points come back as separate series. Missing values stay null.
- An export or read failure marks the cache `stale` or `failed`. Tests assert that the approvals table is unchanged.

## Round 3 (everything above on `main`)

### R3-A: Advocate memory

Branch `andrew-r3-advocate-memory`. Files: `convex/advocates.ts`, plus `convex/agents/advocate.ts` and `convex/lib/advocate.ts` if the scope request is accepted.

- Before the Claude call, recall through Kostya's `backboard.ts`, then `memoryNote(...)`, and put `promptBlock` into this company's prompt only.
- After a recorded outcome, `buildMemoryItem` gives a checked item, which is written to the run's assistant. A write failure changes nothing else.
- Demonstrate Phase 10: state a preference in incident one, and incident two shows "Memory used" with the source event.

### R3-B: Host speech

Branch `andrew-r3-host-speech`. File: `convex/hostTriggers.ts` only.

- After a checked host output is stored, send its canonical text through the voice backend's translation and TTS entry: Claude translation, Cartesia for EN/ZH, Grok TTS for RU.
- Host speech never approves. A translation failure keeps the original text visible.

## Which phases this proves

| Phase | Andrew's evidence |
|---|---|
| 6: calculated options | Cards from `/candidates`, policy-checked advocate outcomes, checked host summary |
| 7: shared coordination | Host clarification, then a requested revision, then a new candidate revision |
| 10: memory and history | Backboard "Memory used" across two incidents, Tiger series with provenance |
| 11/12 | Host trace with provider, model and real result; reset closes the run's memory namespace |

Tick a phase box on #6 only after the demonstration, with a note pointing to the evidence (span output, screenshot, or query result).
