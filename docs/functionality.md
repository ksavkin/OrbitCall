# OrbitCall — Functionality

What OrbitCall does, based on [plan v1](plan-v1.md) and subsequent product decisions. Section references (§) point to plan v1.

Updated Oct 24, 2026 with the decisions in [analysis.md](analysis.md): M1, M2, M4, M5, M7, M8, M10, S1, S3 and S6 are accepted; M9 removes forecasting completely; M3, S2, S4 and S5 are skipped. These are documented requirements, not a claim that the application has been implemented.

This document lists functionality only. Priorities, owners and the schedule belong to the roadmap. Endpoints and data formats belong to `specification.md`, which is written from this document.

Each function has a stable ID (for example `ROOM-3`) so the specification and the roadmap can refer to it. Inside each area, **System** is what OrbitCall does on its own and **User** is what a person sees or does.

---

## 1. Actors

**People**

| Actor | Who | What they do in OrbitCall |
|---|---|---|
| Dispatcher | Flight dynamics engineer at a satellite operator; one per company in a conjunction (Operator A, Operator B) | Watches the queue and personal inbox, reviews incident details and contacts, joins rooms, talks, approves / vetoes / counters, edits the company policy |
| Affected third operator | Owner of a satellite that ends up on the new path after a maneuver | Receives a notice before the maneuver |
| Head of operations | Reads the record after the fact | Reads the audit log to see who said what and when |

**System roles** (§5)

| Role | Does | Does not |
|---|---|---|
| Risk Monitor | Screens every pair, ranks the queue using current evidence, starts the agents on red events | Decide who moves or forecast future risk estimates |
| Incident Analyst | Gathers shareable evidence on a pair and produces a five-line summary with multiple computed proposals | Read either company's private policy or represent either side |
| Operator Advocate (one per company) | Negotiates on behalf of its company within that company's policy | Step outside the policy or execute anything |
| Coordination Host | Opens the room, calls the right people, translates, runs the conversation, writes the log | Vote or decide |
| Maneuver Scheduler | After two approvals of the same proposal ID and revision, re-screens and writes the maneuver to the schedule | Act without current approvals; write outside the one schedule location |
| Maneuver Verifier | Compares the agreed maneuver with later observations and records the evidence in the shared log | Treat sparse orbit changes as proof of an exact burn |

No system role can act on a satellite. Agents read, compute, propose, call, translate and write a file. Only two human approvals put a maneuver into the schedule (§12 item 8).

---

## 2. Domain objects

Names and meaning only; fields and formats are defined in the specification.

| Object | What it is |
|---|---|
| Space object | A satellite or debris object from the catalog, with its orbit (from one or more sources) and metadata: owner, purpose, country, launch date |
| Operator | A company that owns satellites; has a contact, a language and a policy |
| Policy | One operator's private hard constraints and preferences: minimum fuel reserve, protected or preferred mission windows, acceptable risk and mission priority per satellite. Language and shareable operator contact details are separate company settings |
| Conjunction event | Two objects predicted to pass close: time of closest approach (TCA), miss distance, supplied probability (Pc) with source and epoch, relative velocity, color (red / yellow where evidence supports it), status, GP/SupGP source spread, and reference matches. No risk forecast |
| Inbox item | A persistent entry for one person and one conjunction event, with unread updates, the current situation, relevant satellite information, operator contacts and contact methods, and links to the room and log |
| Room | The shared space for one red event: participants, Incident Analyst summary, shareable agent negotiation, human conversation, candidate proposals, selected proposal ID and revision, approval state |
| Message | One line in a room: from an agent or a human, voice or text, the original text plus a translation for each reader's language |
| Constraint | A hard requirement from policy or the incident discussion ("can't move on Wednesday") that the agents must respect, with its source and any later correction |
| Preference | A desired outcome from policy or the incident discussion ("prefer to move after the imaging pass") that the agents weigh while satisfying hard constraints, with its source and any later correction |
| Proposal | One candidate plan with a stable ID and immutable revisions: who moves, when, by how much (delta-v), estimated fuel cost where available, computed miss distance before → after, assumptions, policy feasibility outcomes and rationale. A wait candidate includes a review time or condition |
| Approval | One side's answer to one event, proposal ID and revision: approve, veto or counter; tied to the person's identity and time. Selecting a candidate alone is not approval |
| Maneuver | The approved burn written to the operator's schedule, with the diff of what changes |
| Verification | The promised maneuver, the observations and comparison method, and a result: evidence consistent with the plan, mismatch, or awaiting sufficient data. It does not certify an exact burn from public element sets alone |
| Log entry | One immutable record of a step: time, who (agent or human), what was said or done, numbers before and after |
| Report export | An operator-scoped six-month summary and supporting event records, with counts, source coverage, verification status and missing information for review before regulatory reporting |

---

## 3. Lifecycle of a conjunction

The states below come from §6 and §7. The specification turns them into shared status values.

**Event**

```
new ──(yellow)──▶ stays in the feed and inbox; agents may prepare options, humans are not called
 │
 └─(red)──▶ agents ──▶ proposal ──▶ communication ──▶ approved
                                                       ├─(maneuver)──▶ scheduled
                                                       └─(wait)──────▶ monitoring

scheduled ──(sufficient new data)──▶ verified / flagged (mismatch)
scheduled ──(insufficient data)──▶ awaiting verification data
awaiting verification data ──(sufficient new data)──▶ verified / flagged (mismatch)

agents ──(no mutually acceptable option)──▶ communication (needs operator decision)
proposal / communication ──(veto / counter / relevant discussion update)──▶ agents
approved ──(revised proposal before scheduling)──▶ communication
approved ──(Maneuver Scheduler refusal)──▶ agents
```

The verification branches apply after the maneuver time.

- **new** — the pair is in the queue.
- **agents** — the event turned red; Incident Analyst and Operator Advocates are working ("agents working").
- **proposal** — computed candidate proposals are ready, the room is open and both owners are called. If only one feasible candidate exists, or none, the room explains that instead of inventing alternatives.
- **communication** — the human operators compare proposals, select one for joint review, and discuss it by voice or text with translation. Agents follow both the voice transcripts and text messages, using relevant facts, constraints, preferences and corrections to revise the proposals. Each person can access the incident from their inbox even if the other person has not joined. They can approve, veto or counter in conversation; there is no structured counter form. With one approval the event stays in **communication** and identifies the candidate and revision awaiting the other side.
- **approved** — both owners approved the same selected proposal ID and revision for this incident.
- **scheduled** — Maneuver Scheduler wrote the maneuver and the re-screen found no new conjunction.
- **monitoring** — both owners agreed to wait; the decision and any agreed review time or condition stay visible in the inbox, and no maneuver is scheduled.
- **awaiting verification data** — the maneuver time has passed, but there is not enough new orbit data to determine whether the maneuver matched the promise.
- **verified** — after the maneuver time, sufficient observations are consistent with the promised maneuver ("evidence consistent with plan"), with the comparison and its limits visible.
- **flagged** — new orbit data does not match the promise; both sides are warned.

Transitions back to negotiation: a veto, a counter, relevant new discussion input, or a Maneuver Scheduler refusal because the maneuver would create a new conjunction. Each return carries the new context or refusal reason. Agents distinguish hard constraints from preferences and revise the proposal when the discussion changes feasible options or the preferred outcome. Both owners must approve the revised version; earlier approvals remain in the history and do not authorize it. If a maneuver is already scheduled, new discussion or policy changes flag it for review and can produce a proposed revision, but do not silently rewrite the schedule.

Changing the selected candidate or publishing a revision of the selected plan visibly resets both approvals; switching back does not reactivate old approvals. A material change to its constraints, policy inputs or orbit evidence also invalidates the current approvals and requires review. Unrelated messages do not. Every new incident asks both operators again, even for the same satellite pair; earlier agreements and agent memory never provide standing authorization.

**Cases that remain accessible through the inbox**

Every relevant incident has a persistent entry in each person's website inbox (see [Personal inbox](#61-personal-inbox)), whether or not a call is answered or a proposal is agreed. The entry provides the available collision evidence, satellite information, contact details and contact methods so the person can review the situation and contact the responsible people directly.

| Situation | What the person sees and can do |
|---|---|
| Agents cannot find a mutually acceptable option | "Needs operator decision," with the options considered, conflicting constraints that can be shared, and the reason no agreement was reached. The person can contact the other operator or open the room without an agreed proposal. |
| One operator does not respond | "Waiting for operator," with the latest response status, available contacts and ways to reach them, plus any recorded contact attempts. The incident remains accessible to both people when they return. |
| Updated data shows the event no longer needs action | "No action currently needed," with the updated evidence and the previous history retained. If a maneuver is already scheduled, the change is flagged for operator review. |
| Both operators agree to wait | "Monitoring," with the wait decision, its reason and any agreed review time or condition. Subsequent data updates remain visible in the inbox. |
| There is insufficient new data to verify the maneuver | "Awaiting verification data," with the agreed maneuver, latest available observations and what evidence is missing. Verification is revisited when sufficient data arrives. |

Inbox access does not depend on reaching agreement. Reading an entry or receiving no response does not count as an approval, and missing verification data does not count as a confirmed maneuver or a mismatch.

---

## 4. Orbit data

**System**

- **DATA-1** Pulls the public sources on a schedule: base catalog orbits (CelesTrak GP), operator-supplied orbits (CelesTrak SupGP), a reference conjunction list (CelesTrak SOCRATES), public conjunction messages (Space-Track `cdm_public`), and object metadata (KeepTrack) (§9). Keeps source URLs, object IDs, data epochs and fetch timestamps.
- **DATA-2** Keeps permitted local source snapshots and provenance for reproducible screening and replay without live source requests. Offline room operation also requires the local backend in SYNC-3; cached data does not provide model or voice services.
- **DATA-3** Respects each source's limits: CelesTrak GP at most once per 2 hours per file; Space-Track 3 full-conjunction requests a day, 30 per minute, 300 per hour; KeepTrack 500 per hour.

**User**

- **DATA-4** Can trigger a manual refresh of the data from live sources.

**Demo data**

- **DATA-5** Uses a real conjunction pair from the demo week's SOCRATES or public CDM snapshot, retaining its source and timestamps. Pins a reproducible cached snapshot. Demonstration policies, participants and proposed maneuvers are identified as simulated; historical maneuver verification is a separate, labeled replay. No invented pair or fabricated validation result is presented as live evidence.

---

## 5. Screening and validation

**System**

- **SCR-1** Propagates active objects ahead with SGP4 (deterministic code, not a model) and finds pairs closer than the threshold.
- **SCR-2** Computes TCA, miss distance and relative velocity, and attaches supplied Pc from a matching public CDM where available, or a labeled SOCRATES value. Matches object IDs, encounter time and data version; retains source, epoch and metric type, including whether the source reports a maximum probability. Missing Pc stays unavailable. Does not invent a probability or covariance, use fixed sigma, or reuse the original event's Pc as a post-maneuver estimate.
- **SCR-3** Validates detection over the complete SOCRATES reference list within the selected catalog coverage and horizon on one pinned snapshot. Reports matched / eligible reference events, recall, matching tolerances, exclusions and unmatched events. Separately reports TCA and miss-distance error for matched events. Identifies verified input/element-set differences separately from screening misses; unexplained differences remain unresolved and in the reported denominator.
- **SCR-4** Computes the same conjunction from GP and SupGP where both are available and shows the two results and their min–max spread, with epochs. Labels this as source disagreement, not a calibrated uncertainty interval or probability range.
- **SCR-5** Compares SOCRATES with public CDMs; a pair listed in both, or flagged `EMERGENCY_REPORTABLE` in a CDM, gets higher priority.
- **SCR-6** Retired: risk forecasting is removed entirely. No trained model, persistence forecast, threshold-based forecast, forecast benchmark or predicted trend arrow replaces it. Historical observations remain available as history only.
- **SCR-7** Re-screens a single satellite against the whole catalog on demand (used by the Maneuver Scheduler, EXE-2).

**User**

- **SCR-8** Sees measured reference coverage and numerical agreement with the snapshot, scope, denominator and exclusions accessible. No fixed success count or percentage is hard-coded into the UI or pitch.
- **SCR-9** Sees both source distances, their range and epochs, supplied Pc provenance, and unavailable fields explicitly. Approximate maneuver geometry is labeled indicative; it is not an internally computed Pc.

---

## 6. Conjunction queue

**System**

- **Q-1** Ranks events using current supplied probability and time to TCA, with source emergency flags and cross-source matches where available. Does not use risk forecasts or expose private fuel constraints in a shared score. Missing Pc is marked unavailable and routed for review, not treated as zero risk; its ordering rule is specified separately.
- **Q-2** Colors events: **red** when Pc > 1e-4 and TCA < 72 h; **yellow** when Pc is between 1e-5 and 1e-4.
- **Q-3** On red, starts the agents and creates a room. On yellow, agents may prepare options without calling humans.
- **Q-4** Agents run only for the top of the queue, not for every pair.

**User**

- **Q-5** Sees the feed of conjunctions for their company's satellites: pair, time to conjunction, distance, supplied probability and source, status. Keeps the existing red/yellow and lifecycle presentation; no additional action-label system or heuristic dismissal feature is added.
- **Q-6** Sees an "agents working" mark on events where the agents are running.
- **Q-7** Is called into the room when a proposal is ready.
- **Q-8** Sees the outcome on the row afterwards: evidence consistent with the plan, a mismatch warning, or awaiting verification data.
- **Q-9** Opens a "Verify on CelesTrak" link from each row to the relevant source report or object data. The link identifies what it can verify, and the incident shows source timestamps. If an exact historical event link is unavailable, links to the actual available source without implying that it verifies OrbitCall's proposed maneuver.

### 6.1. Personal inbox

The queue ranks conjunctions for the company. The inbox gives each person a persistent place on the website to find the incidents and updates relevant to them, including those they could not resolve through a call or agent negotiation.

**System**

- **INBOX-1** Creates an inbox entry for each relevant person when a conjunction event concerns their satellites or they receive an affected-operator notice. The entry is available before a proposal or successful call.
- **INBOX-2** Updates the same entry when orbit data, risk, proposals, responses, decisions or verification results change. Keeps unread status per person while the underlying event state is shared.
- **INBOX-3** Includes the available incident information: satellite names and identifiers, owners, orbit data and source timestamps, TCA, miss distance, supplied probability and provenance, labeled source spread, relevant satellite metadata, candidate proposals and selection/revision, summaries, and the current decision or unresolved issue. Missing information is identified as unavailable.
- **INBOX-4** Includes the available contact details of the responsible operators and people the user needs to reach: names, organizations, roles, phone numbers, email addresses, supported in-app contact options, and language or availability information where known. Each contact method shows how to use it; missing contacts are identified explicitly.
- **INBOX-5** Retains access to the incident, its updates, room and audit history when communication fails, negotiation has no agreement, the operators agree to wait, the event no longer needs action, or verification is awaiting data. Access follows the person's company and event permissions; private policy details are restricted by POL-2.

**User**

- **INBOX-6** Opens their personal inbox to see new updates, incidents needing attention and previous incidents, with a clear explanation of the current situation.
- **INBOX-7** Opens an incident to review the collision and satellite information, find or use a provided contact method, and join or reopen the room independently of whether the other person is present.
- **INBOX-8** Can mark an entry as read without approving a proposal or resolving the event.

---

## 7. Operator policy

**System**

- **POL-1** Stores one private policy per operator: minimum fuel reserve, protected and preferred mission windows, acceptable risk and mission priority per satellite. Stores language and shareable contact details separately, even if the first UI uses one settings page.
- **POL-2** Enforces policy privacy in the API, database queries/subscriptions, UI, agent context, logs and exports. Only authorized company users and their Operator Advocate receive raw policy values. The other side, Incident Analyst and Coordination Host receive candidate feasibility outcomes or categories such as "fuel" or "mission window," never private policy values. Shared maneuver parameters remain visible to both; the private limits behind them do not. Shared explanations must not quote those limits.
- **POL-3** When a policy changes, re-runs the negotiation for open, unscheduled events that involve that operator. Flags affected scheduled maneuvers for review; any proposed revision requires fresh approvals before changing the schedule.
- **POL-6** Distinguishes hard constraints that proposals must satisfy from preferences that can be traded off. Applies context learned from voice or text discussion to the current incident; lasting company policy changes are explicit policy updates.
- **POL-7** Does not save an agreement as a standing rule for a satellite pair. Existing company policies may inform the next negotiation, but each new incident and each revised selected plan requires fresh approvals from both operators.

**User**

- **POL-4** Edits their company's policy on a one-page form.
- **POL-5** Sees the proposal change after a policy edit.

---

## 8. Agent negotiation

**System**

- **AGT-1** Incident Analyst gathers shareable evidence: both orbits, source spread, supplied Pc and provenance, owner/purpose/country, and shared incident history. Each Operator Advocate evaluates fuel, mission windows and other private constraints locally and returns shareable feasibility outcomes.
- **AGT-2** Incident Analyst produces a five-line summary and multiple computed candidate proposals for joint human choice. Deterministic tools evaluate a small grid of moving satellite, burn time and delta-v; each card shows estimated geometry, available fuel estimates, assumptions and policy feasibility. Start with 2–3 candidates when feasible, plus waiting with a review condition where appropriate. A simple along-track approximation may support the demo, but is labeled indicative and followed by the defined re-screen; it is not a production optimizer or proof of a target Pc. Insufficient data and fewer feasible candidates are shown honestly.
- **AGT-3** Operator Advocates A and B evaluate and discuss candidates within their private policies and can recommend a preferred candidate with a shareable explanation. Humans can compare alternatives and select one for joint approval; the agents do not choose or authorize a maneuver for them.
- **AGT-4** A relevant new fact, constraint, preference or correction from human discussion, a veto, a counter or a Maneuver Scheduler refusal makes the agents reconsider the proposal and recompute candidate outcomes as needed.
- **AGT-5** Every number in a rationale comes from computation, not generation; each explanation passes a deterministic check against the numbers before it reaches a person.
- **AGT-6** A second, independent model reads the rationale and flags disagreement to the humans.
- **AGT-7** An Operator Advocate remembers past incidents between rooms (for example, that it yielded last time). This is context only and never a standing rule or reused approval.
- **AGT-10** If no mutually acceptable option is found, records the outcome and a shareable explanation of the disagreement in the inbox and room so humans can continue the discussion directly.
- **AGT-11** Follows the incident's ongoing conversation through transcribed voice and posted text messages, including messages sent when the other operator is absent. Uses the conversation history and speaker identity to interpret new information and corrections; users do not need to manually re-enter discussion points in a policy form or press re-run for routine updates.
- **AGT-12** Automatically prepares a revised proposal when discussion changes the feasible options or preferred outcome. Recomputes numerical results through the deterministic tools and checks the explanation before publishing the revision in the room and inbox, with what changed, why, and links to the relevant messages. Unrelated conversation does not trigger a proposal replacement.
- **AGT-13** Distinguishes firm requirements, preferences, hypothetical suggestions and corrections. Asks for clarification in the room when meaning is ambiguous or a statement conflicts with a hard policy rule; does not silently relax that rule. Operators can correct the agent's interpretation by voice or text.

**User**

- **AGT-8** Sees the Incident Analyst summary, candidate comparisons and the shareable transcript of the agents' negotiation; private policy values and internal reasoning are excluded.
- **AGT-9** Can re-run the agents if they hang.

---

## 9. Coordination Host and calling people

**System**

- **DSP-1** Opens a room for a red event.
- **DSP-2** Finds and calls the two owners using operator metadata and shareable contact settings, without access to private operational policy values.
- **DSP-3** Finds operators whose satellites the proposed maneuver affects, and notifies them before the maneuver.
- **DSP-4** Runs the conversation in the room and writes every step to the log.
- **DSP-7** Makes the incident and available operator contact methods accessible in each relevant person's inbox regardless of whether they answer the call or join the room.

**User**

- **DSP-5** Receives a call or invitation when a proposal is ready, sees whether the other operator has joined, and can join or return to the incident through the inbox.
- **DSP-6** As an affected third operator, receives a notice about the new path before the maneuver.

---

## 10. Conjunction room

**System**

- **ROOM-1** Holds the room state: participants, summary, shareable negotiation, conversation, candidate proposals, selected proposal ID and revision, approval state of each side.
- **ROOM-2** Schedules only when both owners have current approvals for the same incident, selected proposal ID and revision. Approving different alternatives does not reach agreement. If both approve a wait candidate, records it and moves to monitoring without a maneuver. A veto or conversational counter returns to negotiation.
- **ROOM-3** Shows each side only its own controls and private policy panel, with a visible privacy indicator, and translates shared lines into that side's language. The opposing policy is inaccessible, not merely hidden in the browser.
- **ROOM-11** Tracks approvals by incident, proposal ID and revision. Selection changes and new revisions reset both approvals visibly (for example, "P2 · R2 created — both approvals reset"). The backend rejects stale approvals and rechecks the current selection, revision and both authorizations atomically before scheduling. Earlier approvals remain historical and cannot be revived by switching back. Changes to an already scheduled maneuver remain proposed changes until explicitly approved.

**User**

- **ROOM-4** Sees both orbits, the conjunction point and a countdown to TCA.
- **ROOM-5** Compares candidate cards: proposal ID/revision, who moves, when, delta-v, estimated fuel where available, computed distance before → after, assumptions and shareable feasibility. Can select a candidate for joint review; selection alone does not approve it.
- **ROOM-6** Talks and writes to the other operator by voice or text.
- **ROOM-7** Approves or vetoes the selected candidate revision, or counters through ordinary voice or free-text conversation. No separate structured counter-proposal fields are built. Spoken approval is accepted only when the speaker and exact current candidate/revision are unambiguous; otherwise the room asks for confirmation of that choice.
- **ROOM-8** Sees candidate/revision-specific status: "P2 · R2 · A approved · waiting for B," a visible reset when it changes, and separate approval, re-screen and scheduling results.
- **ROOM-9** Sees the maneuver diff (what will change in the schedule) before approving.
- **ROOM-10** Sees a chart of historical supplied Pc or miss distance with source timestamps. It contains observations only, without a forecast curve or predicted trend.
- **ROOM-12** Sees the facts, hard constraints and preferences the agents understood from shared discussion, plus shareable policy outcomes/categories under POL-2, and an explanation of each proposal revision. Can correct those interpretations in the conversation; private policy values are not added to the shared view.

---

## 11. Translation and voice

**System** (§8)

- **LANG-1** Recognizes speech as a stream, phrase by phrase.
- **LANG-2** Translates voice transcripts and text with room context while protecting numbers, units, signs, dates/times, time zones and satellite IDs as typed placeholders. Restores them after translation from the authoritative proposal revision for proposal text, or the original message for human speech/text, including newly suggested values. Checks placeholder integrity before display or speech; retries or shows the original if validation fails. Does not replace a new conversational value with an older card value or ask the model to invent one. Ambiguous speech recognition is clarified before it changes a proposal.
- **LANG-3** Delivers each phrase to the listener as voice and text in their language; the speaker sees their original in the transcript.
- **LANG-4** Feeds transcribed voice and posted text messages into the agents' conversation context, retaining the speaker, original wording and translations. Relevant facts, hard constraints, preferences and corrections can trigger a revised proposal (AGT-11..AGT-13).
- **LANG-5** Writes both language versions of every phrase to the log.
- **LANG-6** Gives the Coordination Host a voice and accepts spoken approval only under ROOM-7's identity and exact-proposal checks; translation or a casual acknowledgement never creates an approval by itself.
- **LANG-7** Works in text only when voice is unavailable, with the same translation.

**User**

- **LANG-8** Speaks and reads in their own language and can open the original wording beside a translation in one click.

---

## 12. Execution

**System** (§5, §6)

- **EXE-1** After both owners approve the same selected proposal ID and revision and its re-screen passes, writes that exact maneuver to the operator's schedule location; it has write access to that location only. Rechecks that the approvals and inputs are current before committing; retries cannot create duplicate schedule entries.
- **EXE-2** Re-screens the moved satellite against the whole catalog, not only against its partner.
- **EXE-3** If the re-screen finds a new conjunction, refuses and returns to negotiation with that as a constraint.
- **EXE-4** Produces the diff of what will change, for the room (ROOM-9).

---

## 13. Verification

**System**

- **VER-1** After the maneuver time, compares the approved proposal's promised time, direction and approximate size with later observations. The demo method examines semi-major-axis or mean-motion changes across a time series of element sets against the object's own baseline noise, then compares the observed trend with the expected change from deterministic tools. Records sources, epochs, method, thresholds and limitations; an element-set jump alone is not proof of an exact delta-v or execution time.
- **VER-2** With sufficient evidence, records "evidence consistent with plan" or a mismatch in the shared promised-versus-observed record and notifies both sides. Shows the agreed values beside observed evidence; never labels a scheduled maneuver as executed solely because it was approved or written to a file.
- **VER-3** Demonstrates the comparison on a sourced historical maneuver, such as an ISS reboost or a documented Starlink burn, with observations before and after. Labels the replay separately from the current real conjunction demo; any demonstration agreement is explicitly simulated.
- **VER-4** When data is sparse, noisy, stale or contradictory, keeps verification pending and shows the missing evidence in the inbox. Rechecks when sufficient data arrives; absence of a detectable jump is not automatically a mismatch.

---

## 14. Audit log

**System**

- **LOG-1** Keeps an immutable shared incident log accessible to authorized participants. Private policy records and internal agent context remain company-scoped and are never copied into shared log entries or report exports.
- **LOG-2** Records every shared agent message, every shared human line in both languages, each candidate selection and approval / veto / conversational counter with identity, time and proposal ID/revision, every Maneuver Scheduler result, and the promised-versus-observed verification evidence.
- **LOG-3** Each entry has time, who (agent or human), what was said or done, and numbers before and after.
- **LOG-5** Records no-agreement outcomes, contact attempts made through the system, wait decisions, changes indicating no action is currently needed, and verification delays with their reasons. These records are linked from the inbox.
- **LOG-6** Records facts, constraints, preferences and corrections from shared discussion with their source messages, and each resulting proposal version with the reason for the change. Private policy changes contribute only shareable outcomes/categories to this log. Preserves approvals and their invalidation/reset history for each candidate revision.
- **LOG-7** Generates an operator-scoped six-month report draft from canonical incident records. Includes reporting period, satellites covered, unique conjunction count, events with operator coordination, events with maneuvers, unresolved events, and supporting incident references. Separates planned/scheduled maneuvers from observed or operator-confirmed execution; overlapping coordination/maneuver categories are not added as disjoint totals. Revisions and repeated alerts do not count as new events. Shows missing source coverage and unresolved event matches explicitly.
- **LOG-8** Supports a reviewed mapping to the applicable FCC space-system safety report requirements (S3's target: FCC 26-47, §100.201(d)). Keeps rule/version, reporting-period definition and field provenance with the export. Marks required fields outside OrbitCall's data as missing and allows explicit operator-supplied values with provenance before export. Does not invent zero counts, auto-file a report, or claim complete regulatory compliance from a partial log; current applicability, effective dates and final field mapping must be verified before a filing-ready template is released.

**User**

- **LOG-4** Reads the log for an event or across events.
- **LOG-9** Selects their operator and reporting period, previews the counts, coverage and missing fields, and downloads the report draft with a CSV of its supporting event records. Reviews and completes information before using it for reporting; private policy values are excluded.

---

## 15. Identity and sides

**System**

- **ACC-1** Each person signs in as an operator of their company, with the role "owner of" specific satellites.
- **ACC-2** An approval is tied to the authenticated person's company, incident, proposal ID and revision. The server authorizes each read and write, including live subscriptions and report exports; changing a browser role label cannot expose another company's policy or approve for it.
- **ACC-3** The same screens serve both companies; content and controls depend on whose side the viewer is on.

---

## 16. Live updates and resilience

**System**

- **SYNC-1** All state (events, policies, rooms, messages, proposals, approvals, inbox entries and per-person read status, log) lives in one source of truth.
- **SYNC-2** Changes appear on every open screen at the same time, without reloading.
- **SYNC-3** Provides a local-backend fallback in which one machine serves the other over the local network using cached orbital snapshots. The local deployment must preserve the same company access controls and approval rules as the hosted application; this remains an implementation and validation requirement.
- **SYNC-4** Without internet, cached data and local text-room state remain available only when that local deployment is running. Cloud voice, model-driven negotiation and translation are unavailable; a labeled recording may demonstrate those parts without pretending to be a live update.

---

## 17. External agent access

**System** (§11, Fetch.ai)

- **EXT-1** Each system role runs as a separate agent with its own address.
- **EXT-2** Operator Advocates negotiate by real messages over a standard agent chat protocol.
- **EXT-3** The main scenario can be started from an external agent chat (ASI:One).

---

## 18. Screens

Which functions each screen shows (§7).

| Screen | What's on it | Functions |
|---|---|---|
| 1. Ops board | Conjunction queue, globe with the constellation, measured reference coverage and numerical agreement, source links, refresh | Q-5..Q-9, SCR-8, DATA-4 |
| 2. Conjunction room | Orbits and countdown, summary, shareable negotiation, voice/text discussion, candidate comparison and selection, revisions and visible approval resets, Approve / Veto / conversational Counter, both sides' status, own-policy privacy indicator, maneuver diff, historical observations | ROOM-3..ROOM-12, AGT-8, AGT-9, LANG-8, SCR-9 |
| 3. Policy | Private company policy form; separate shareable contact/language settings | POL-1, POL-2, POL-4, POL-5 |
| 4. Audit log and reports | Shared history, promised-versus-observed evidence, operator-scoped reporting period, coverage preview and report export | LOG-4, LOG-7..LOG-9 |
| 5. Personal inbox | Relevant incidents and unread updates; current situation; collision and satellite details; operator contacts and contact methods; links to the room and history | INBOX-6..INBOX-8 |

---

## 19. Out of scope

From §12 "What we don't promise":

- Internally computed Pc or invented covariance; supplied probability is taken from matching SOCRATES / CDMs with provenance.
- Production maneuver optimization; the demo compares a bounded set of computed candidates and clearly labeled approximations.
- Risk forecasting of any kind, including a replacement baseline or forecast benchmark. Historical observations remain in scope.
- Structured counter-proposal forms, saved pair agreements / standing authorization, extra queue action labels and heuristic dismissal rules (M3, S2, S4, S5).
- Automatic regulatory filing or a claim that the log alone is a complete compliant report.
- Replacing the operator; no system role acts on a satellite.
- Making operators share data; that is policy, not software.

---

## 20. Open questions for the specification

The accepted decisions below retain the original question numbers so existing references remain meaningful. Remaining details belong in the specification.

1. **Screening horizon:** 7 days ahead (§6) or 3 days (§13)?
2. **Refresh and Risk Monitor cadence:** every 15 minutes (§6) or every 5 minutes (§13)?
3. **Resolved — proposal choice:** multiple computed candidates; start with 2–3 when feasible, with explicit selection and both approvals of the same candidate revision (S1).
4. **Resolved — Counter:** voice and free text feed automatic revisions; no structured counter form (M3 skipped).
5. **Resolved — policy visibility:** raw policy values are private to the company and its Operator Advocate; shared outcomes/categories and the proposed maneuver are visible (M2).
6. **Calling people:** is the Coordination Host's call in-app only, or also email / phone / push?
7. **Third-party notice:** through which channel, and does the third operator get a room or only a notice?
8. **Event identity:** how do we match the same pair across our screening, SOCRATES and CDMs (object IDs + TCA window)?
9. **Yellow events:** do prepared options for yellow events persist and show anywhere, or are they discarded?
10. **Reporting template:** verify the current FCC rule, applicability, periods and required fields; choose the human-readable export format and define completion of fields absent from the incident log (S3).
11. **Evidence methods:** specify the candidate grid, approximation validity, feasibility and re-screen criteria, and the verification baseline/window/thresholds. Do not substitute an unsupported post-maneuver Pc for these checks (S1, M7, M8).
12. **Missing Pc:** define review priority for events without a usable supplied probability; unavailable does not mean safe (M8).
