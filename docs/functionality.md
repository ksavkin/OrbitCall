# OrbitCall — Functionality

What OrbitCall does, derived from [plan v1](plan-v1.md). Section references (§) point to it.

This document lists functionality only. Priorities, owners and the schedule belong to the roadmap. Endpoints and data formats belong to `specification.md`, which is written from this document.

Each function has a stable ID (for example `ROOM-3`) so the specification and the roadmap can refer to it. Inside each area, **System** is what OrbitCall does on its own and **User** is what a person sees or does.

---

## 1. Actors

**People**

| Actor | Who | What they do in OrbitCall |
|---|---|---|
| Dispatcher | Flight dynamics engineer at a satellite operator; one per company in a conjunction (Operator A, Operator B) | Watches the queue, joins rooms, talks, approves / vetoes / counters, edits the company policy |
| Affected third operator | Owner of a satellite that ends up on the new path after a maneuver | Receives a notice before the maneuver |
| Head of operations | Reads the record after the fact | Reads the audit log to see who said what and when |

**System roles** (§5)

| Role | Does | Does not |
|---|---|---|
| Scout | Screens every pair, ranks the queue, forecasts whether risk will rise or fall, starts the agents on red events | Decide who moves |
| Analyst | Gathers everything on a pair and produces a five-line summary with options | Represent either side |
| Operator agent (one per company) | Negotiates on behalf of its company within that company's policy | Step outside the policy or execute anything |
| Dispatcher | Opens the room, calls the right people, translates, runs the conversation, writes the log | Vote or decide |
| Executor | After two approvals writes the maneuver to the schedule and re-screens the moved satellite against the whole catalog | Act without two approvals; write outside the one schedule location |
| Verifier | After the maneuver time checks new orbit data against the promised maneuver | — |

No system role can act on a satellite. Agents read, compute, propose, call, translate and write a file. Only two human approvals put a maneuver into the schedule (§12 item 8).

---

## 2. Domain objects

Names and meaning only; fields and formats are defined in the specification.

| Object | What it is |
|---|---|
| Space object | A satellite or debris object from the catalog, with its orbit (from one or more sources) and metadata: owner, purpose, country, launch date |
| Operator | A company that owns satellites; has a contact, a language and a policy |
| Policy | One operator's rules: minimum fuel reserve, "don't move" mission windows, acceptable risk, mission priority per satellite, language, contact |
| Conjunction event | Two objects predicted to pass close: time of closest approach (TCA), miss distance, probability (Pc), relative velocity, color (red / yellow), status, risk trend, uncertainty from comparing orbit sources, which reference sources also list it |
| Room | The shared space for one red event: participants, Analyst summary, agent negotiation, human conversation, current proposal, approval state |
| Message | One line in a room: from an agent or a human, voice or text, the original text plus a translation for each reader's language |
| Constraint | A new fact a human adds ("can't move on Wednesday") that the agents must respect when they recompute |
| Proposal | Who moves, when, by how much (delta-v), fuel cost, miss distance before → after, and the rationale |
| Approval | One side's answer to a proposal: approve, veto or counter; tied to the person's identity and time |
| Maneuver | The approved burn written to the operator's schedule, with the diff of what changes |
| Verification | The result of comparing new orbit data against the promised maneuver: confirmed or mismatch |
| Log entry | One immutable record of a step: time, who (agent or human), what was said or done, numbers before and after |

---

## 3. Lifecycle of a conjunction

The states below come from §6 and §7. The specification turns them into shared status values.

**Event**

```
new ──(yellow)──▶ stays in the feed; agents may prepare options, humans are not called
 │
 └─(red)──▶ agents ──▶ proposal ──▶ approved ──▶ scheduled ──▶ verified
                ▲          │            │                       └──▶ flagged (mismatch)
                │          │            │
                └──────────┴────────────┘
             veto / counter / new constraint / Executor refusal
```

- **new** — the pair is in the queue.
- **agents** — the event turned red; Analyst and operator agents are working ("agents working").
- **proposal** — a proposal is ready, the room is open and both owners are called.
- **approved** — both owners approved. With one approval the event stays in **proposal** and shows "waiting for the other side."
- **scheduled** — Executor wrote the maneuver and the re-screen found no new conjunction.
- **verified** — after the maneuver time, new orbit data matches the promise ("maneuver confirmed").
- **flagged** — new orbit data does not match the promise; both sides are warned.

Transitions back to negotiation: a veto, a counter, a new human constraint, or an Executor refusal because the maneuver would create a new conjunction. Each return carries the reason as a new constraint.

---

## 4. Orbit data

**System**

- **DATA-1** Pulls the open sources on a schedule: base catalog orbits (CelesTrak GP), operator-supplied orbits (CelesTrak SupGP), a reference conjunction list (CelesTrak SOCRATES), official public conjunction messages (Space-Track `cdm_public`), object metadata (KeepTrack), and historical conjunction messages (ESA Kelvins) (§9).
- **DATA-2** Keeps a local snapshot of every source so everything works without network.
- **DATA-3** Respects each source's limits: CelesTrak GP at most once per 2 hours per file; Space-Track 3 full-conjunction requests a day, 30 per minute, 300 per hour; KeepTrack 500 per hour.

**User**

- **DATA-4** Can trigger a manual refresh of the data from live sources.

---

## 5. Screening and validation

**System**

- **SCR-1** Propagates active objects ahead with SGP4 (deterministic code, not a model) and finds pairs closer than the threshold.
- **SCR-2** For each pair computes TCA, miss distance and relative velocity, and attaches probability from SOCRATES / CDMs. True Pc with covariances is not computed (§12).
- **SCR-3** Validates its own screening against SOCRATES: of SOCRATES' top 50, how many it finds within 500 m and a few seconds of TCA.
- **SCR-4** Computes the same conjunction on two orbit sources (GP and SupGP); the difference in miss distance is the uncertainty shown for the event.
- **SCR-5** Compares SOCRATES with public CDMs; a pair listed in both, or flagged `EMERGENCY_REPORTABLE` in a CDM, gets higher priority.
- **SCR-6** Forecasts whether an event's risk will rise or fall, using a model trained on the ESA Kelvins history. The forecast is used only if it beats the rule "current risk = final risk."
- **SCR-7** Re-screens a single satellite against the whole catalog on demand (used by the Executor, EXE-2).

**User**

- **SCR-8** Sees the validation result as a number on the board ("Validated vs SOCRATES: N/50 within 500 m").
- **SCR-9** Sees for an event both distances and their difference ("US data says X m, operator data says Y m").

---

## 6. Conjunction queue

**System**

- **Q-1** Ranks events by probability divided by hours to TCA, adjusted for fuel and the risk forecast.
- **Q-2** Colors events: **red** when Pc > 1e-4 and TCA < 72 h; **yellow** when Pc is between 1e-5 and 1e-4.
- **Q-3** On red, starts the agents and creates a room. On yellow, agents may prepare options without calling humans.
- **Q-4** Agents run only for the top of the queue, not for every pair.

**User**

- **Q-5** Sees the feed of conjunctions for their company's satellites: pair, time to conjunction, distance, probability, risk trend arrow, status.
- **Q-6** Sees an "agents working" mark on events where the agents are running.
- **Q-7** Is called into the room when a proposal is ready.
- **Q-8** Sees the outcome on the row afterwards: "maneuver confirmed" or a warning.

---

## 7. Operator policy

**System**

- **POL-1** Stores one policy per operator: minimum fuel reserve, "don't move" mission windows, acceptable risk, mission priority per satellite, language, contact.
- **POL-2** Gives each operator agent only its own company's policy.
- **POL-3** When a policy changes, re-runs the negotiation for open events that involve that operator.

**User**

- **POL-4** Edits their company's policy on a one-page form.
- **POL-5** Sees the proposal change after a policy edit.

---

## 8. Agent negotiation

**System**

- **AGT-1** Analyst gathers everything on the pair: both orbits, uncertainty, fuel, mission windows, owner/purpose/country, history of concessions.
- **AGT-2** Analyst produces a five-line summary and options. Maneuver options are fixed: raise, lower, wait.
- **AGT-3** Operator agents A and B exchange messages and converge on who moves, when, by how much, and the resulting miss distance, each within its own policy.
- **AGT-4** A new constraint from a human, a veto, a counter or an Executor refusal makes the agents recompute.
- **AGT-5** Every number in a rationale comes from computation, not generation; each explanation passes a deterministic check against the numbers before it reaches a person.
- **AGT-6** A second, independent model reads the rationale and flags disagreement to the humans.
- **AGT-7** An operator agent remembers past incidents between rooms (for example, that it yielded last time).

**User**

- **AGT-8** Sees the Analyst summary and the transcript of the agents' negotiation.
- **AGT-9** Can re-run the agents if they hang.

---

## 9. Dispatcher and calling people

**System**

- **DSP-1** Opens a room for a red event.
- **DSP-2** Finds and calls the two owners, using operator metadata and policy contacts.
- **DSP-3** Finds operators whose satellites the proposed maneuver affects, and notifies them before the maneuver.
- **DSP-4** Runs the conversation in the room and writes every step to the log.

**User**

- **DSP-5** Receives a call: "proposal ready, the other operator is in the room," and joins.
- **DSP-6** As an affected third operator, receives a notice about the new path before the maneuver.

---

## 10. Conjunction room

**System**

- **ROOM-1** Holds the room state: participants, summary, negotiation, conversation, current proposal, approval state of each side.
- **ROOM-2** Schedules the maneuver only after both owners approve. One veto or counter returns to negotiation.
- **ROOM-3** Shows each side only its own controls, and every line in that side's language.

**User**

- **ROOM-4** Sees both orbits, the conjunction point and a countdown to TCA.
- **ROOM-5** Sees the proposal card: who moves, when, delta-v, fuel, distance before → after.
- **ROOM-6** Talks and writes to the other operator by voice or text.
- **ROOM-7** Approves, vetoes or counters the proposal.
- **ROOM-8** Sees the other side's status: "waiting for B," then "both approved, scheduled, checked against the catalog."
- **ROOM-9** Sees the maneuver diff (what will change in the schedule) before approving.
- **ROOM-10** Sees a chart of how risk for this event changed over time.

---

## 11. Translation and voice

**System** (§8)

- **LANG-1** Recognizes speech as a stream, phrase by phrase.
- **LANG-2** Translates each phrase with the room's context (satellite names, terms like "imaging window" or "burn"), leaving numbers untouched.
- **LANG-3** Delivers each phrase to the listener as voice and text in their language; the speaker sees their original in the transcript.
- **LANG-4** Passes a phrase that carries a constraint ("can't move on Wednesday") to the agents.
- **LANG-5** Writes both language versions of every phrase to the log.
- **LANG-6** Gives the Dispatcher a voice: it can speak to the humans and accept a spoken "approve."
- **LANG-7** Works in text only when voice is unavailable, with the same translation.

**User**

- **LANG-8** Speaks and reads in their own language; no human translator is needed.

---

## 12. Execution

**System** (§5, §6)

- **EXE-1** After two approvals, writes the maneuver file to the operator's schedule location; it has write access to that location only.
- **EXE-2** Re-screens the moved satellite against the whole catalog, not only against its partner.
- **EXE-3** If the re-screen finds a new conjunction, refuses and returns to negotiation with that as a constraint.
- **EXE-4** Produces the diff of what will change, for the room (ROOM-9).

---

## 13. Verification

**System**

- **VER-1** After the maneuver time, compares new orbit data with the promised maneuver.
- **VER-2** On a match, marks the event verified ("maneuver confirmed"); on a mismatch, flags it to both sides.
- **VER-3** Can run on historical orbit data (for example, a real past Starlink maneuver) to show the change.

---

## 14. Audit log

**System**

- **LOG-1** Keeps one immutable log, visible to both sides.
- **LOG-2** Records every agent message, every human line in both languages, every approval / veto / counter with identity and time, every Executor result, and the verification result.
- **LOG-3** Each entry has time, who (agent or human), what was said or done, and numbers before and after.

**User**

- **LOG-4** Reads the log for an event or across events.

---

## 15. Identity and sides

**System**

- **ACC-1** Each person signs in as an operator of their company, with the role "owner of" specific satellites.
- **ACC-2** An approval is tied to the identity of the person who gave it.
- **ACC-3** The same screens serve both companies; content and controls depend on whose side the viewer is on.

---

## 16. Live updates and resilience

**System**

- **SYNC-1** All state (events, policies, rooms, messages, proposals, approvals, log) lives in one source of truth.
- **SYNC-2** Changes appear on every open screen at the same time, without reloading.
- **SYNC-3** Works fully from the local snapshot when there is no network; one machine can serve the backend to the other over the local network.
- **SYNC-4** Without network, only voice and model calls are lost; text mode and cached data keep working.

---

## 17. External agent access

**System** (§11, Fetch.ai)

- **EXT-1** Each system role runs as a separate agent with its own address.
- **EXT-2** Operator agents negotiate by real messages over a standard agent chat protocol.
- **EXT-3** The main scenario can be started from an external agent chat (ASI:One).

---

## 18. Screens

Which functions each screen shows (§7).

| Screen | What's on it | Functions |
|---|---|---|
| 1. Ops board | Conjunction queue, globe with the constellation, validation number, refresh | Q-5..Q-8, SCR-8, DATA-4 |
| 2. Conjunction room | Orbits and countdown, summary, negotiation transcript, human conversation, proposal card, Approve / Veto / Counter, both sides' status, maneuver diff, risk chart | ROOM-4..ROOM-10, AGT-8, AGT-9, LANG-8, SCR-9 |
| 3. Policy | One-page policy form | POL-4, POL-5 |
| 4. Audit log | Log entries with verification marks | LOG-4 |

---

## 19. Out of scope

From §12 "What we don't promise":

- True Pc with covariances; taken from SOCRATES / CDMs.
- Maneuver planning with delta-v optimization; only the fixed options raise, lower, wait.
- Replacing the operator; no system role acts on a satellite.
- Making operators share data; that is policy, not software.

---

## 20. Open questions for the specification

Plan v1 leaves these open or contradicts itself; the specification has to settle them.

1. **Screening horizon:** 7 days ahead (§6) or 3 days (§13)?
2. **Refresh and Scout cadence:** every 15 minutes (§6) or every 5 minutes (§13)?
3. **Analyst options:** two (§5 text), two or three (§5 roles table), or three (§13)?
4. **Counter:** what does a counter contain beyond "returns to negotiation with a constraint" — a free-text line, or a structured counter-proposal?
5. **Policy visibility:** can one side see the other side's policy, or only the outcome?
6. **Calling people:** is the Dispatcher's call in-app only, or also email / phone / push?
7. **Third-party notice:** through which channel, and does the third operator get a room or only a notice?
8. **Event identity:** how do we match the same pair across our screening, SOCRATES and CDMs (object IDs + TCA window)?
9. **Yellow events:** do prepared options for yellow events persist and show anywhere, or are they discarded?
