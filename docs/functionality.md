# OrbitCall — Functionality

What OrbitCall does, based on [plan v1](plan-v1.md) and subsequent product decisions. Section references (§) point to plan v1.

Updated Oct 24, 2026 with the decisions in [analysis.md](analysis.md): M1, M2, M4, M5, M7, M8, M10, S1, S3 and S6 are accepted; M9 removes forecasting completely; M3, S2, S4 and S5 are skipped. These are documented requirements, not a claim that the application has been implemented.

Final review decisions (Oct 24, 2026) are applied: demo encounters use flagged simulated spacecraft against the real catalog (DATA-5, DATA-7, SCR-10), with two simulated US objects permitted for the linked three-operator story. The schedule location is defined (EXE-1), sign-in uses pre-created test users (ACC-1), and section 20 records the demo defaults. The room is an always-on chat with an optional live call. Approval is an event-specific checkmark (ROOM-7, ROOM-13). Calling operators and notices to unrelated affected operators come after the base build.

Current user-approved amendment: [assigned-fleet workflow](user-flow.md). My Fleet + My Incidents + globe is the main screen. Run Scan checks assigned objects against the usable catalog for 72 hours. Severity then nearest closest approach determines order; missing/stale evidence is a separate visible review section. Up to four computed options are shown. Selection and Approve are separate. Confirmed debris has a distinct unilateral approval path. References to two owners/both approvals describe bilateral events unless noted.

Latest scope and stack: [master-roadmap.md](master-roadmap.md). The hackathon demo uses three dispatcher laptops and a read-only large display, group rooms for 2-4 operators with pair-specific approvals, English/Russian/Mandarin voice, DigitalOcean hosting, and separate Factory/Backboard/Tiger Data roles. These accepted targets supersede older two-user-only, pair-room-only, and hosting/provider alternatives below.

Master roadmap v1.1 is the source of truth for provider ownership: Claude runs the Incident Analyst, private Operator Advocates and translation. Gemini runs the Coordination Host. Grok independently checks rationale and handles STT/Russian TTS. The host follows the same privacy, number-checking and human-approval rules as the other agents.

This document lists functionality only. Priorities, owners and the schedule belong to the roadmap. Endpoints and data formats belong to `specification.md`, which is written from this document.

Each function has a stable ID (for example `ROOM-3`) so the specification and the roadmap can refer to it. Inside each area, **System** is what OrbitCall does on its own and **User** is what a person sees or does.

---

## Runtime mode decision (October 24)

The user confirmed: Dev on keeps the working TLE catalog and synthetic conjunction scenarios. Dev off is the real mode and requires backend OMM, with no silent TLE or simulation fallback. Until the OMM backend and frontend integration are ready, show an explicit unavailable/integration-pending state. This applies in both Git branches; `main` is not a runtime data mode. CelesTrak remains the source. OMM is an exchange format, not an automatic improvement in orbit accuracy. It supports larger object IDs and avoids legacy TLE format limits. See [CelesTrak format documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php).

## 1. Actors

**People**

| Actor | Who | What they do in OrbitCall |
|---|---|---|
| Dispatcher | Flight dynamics engineer at a satellite operator, with a server-assigned fleet; A/B are stable incident sides, not fixed user identities | Watches the queue and personal inbox, reviews incident details and contacts, joins rooms, talks, approves / vetoes / counters, edits the company policy |
| Affected third operator | Owner of a satellite that ends up on the new path after a maneuver | Receives a notice before the maneuver |
| Head of operations | Reads the record after the fact | Reads the audit log to see who said what and when |

**System roles** (§5)

| Role | Does | Does not |
|---|---|---|
| Risk Monitor | Screens assigned fleet objects against the catalog, ranks each user's relevant queue using current evidence, starts the agents on red events | Decide who moves or forecast future risk estimates |
| Incident Analyst | Gathers shareable evidence on a pair and produces a five-line summary with multiple computed proposals | Read either company's private policy or represent either side |
| Operator Advocate (one per company) | Negotiates on behalf of its company within that company's policy | Step outside the policy or execute anything |
| Coordination Host | Gemini interprets shared discussion, asks clarifications and summarizes each linked incident. Convex publishes checked results and Claude translates them | Read private policy, approve, or decide for operators |
| Maneuver Scheduler | After all required approvals for the workflow (two active-operator sides, or one active side for confirmed debris) of the same proposal ID and revision, re-screens and writes the maneuver to the schedule | Act without current approvals; write outside the one schedule location |
| Maneuver Verifier | Compares the agreed maneuver with later observations and records the evidence in the shared log | Treat sparse orbit changes as proof of an exact burn |

No system role can act on a satellite. Agents read, compute, propose, call, translate and write a file. Only the workflow's required authenticated human approvals can put a maneuver into the schedule (ROOM-14).

---

## 2. Domain objects

Names and meaning only; fields and formats are defined in the specification.

| Object | What it is |
|---|---|
| Space object | A satellite or debris object from the catalog, with its orbit (from one or more sources) and metadata: owner, purpose, country, launch date |
| Operator | A company that owns or operates satellites; has shareable contacts and a private policy |
| Fleet assignment | Server-managed user-to-object responsibility within a company, with a version and validity. Distinct from ownership, user country and display language |
| Scan run | One authenticated assigned-fleet screening job with pinned assignments, snapshot, 72-hour window, progress, results and explicit coverage |
| Policy | One operator's private hard constraints and preferences: minimum fuel reserve, protected or preferred mission windows, acceptable risk and mission priority per satellite. Language and shareable operator contact details are separate company settings |
| Conjunction event | Two objects predicted to pass close: time of closest approach (TCA), miss distance, supplied probability (Pc) with source and epoch, relative velocity, color (red / yellow where evidence supports it), status, GP/SupGP source spread, and reference matches. No risk forecast |
| Inbox item | A persistent entry for one person and one conjunction event, with unread updates, the current situation, relevant satellite information, operator contacts and contact methods, and links to the room and log |
| Room | Shared discussion for linked pair events and 2-4 operator companies. Chat, call and membership are room-scoped. Each event keeps its own summary, candidate revisions, selection and approval state |
| Message | One line in a room: from an agent or a human, voice or text, the original text plus a translation for each reader's language |
| Constraint | A hard requirement from policy or the incident discussion ("can't move on Wednesday") that the agents must respect, with its source and any later correction |
| Preference | A desired outcome from policy or the incident discussion ("prefer to move after the imaging pass") that the agents weigh while satisfying hard constraints, with its source and any later correction |
| Proposal | One candidate plan with a stable ID and immutable revisions: who moves, when, by how much (delta-v), estimated fuel cost where available, computed miss distance before → after, assumptions, policy feasibility outcomes and rationale. A wait candidate includes a review time or condition |
| Approval | One side's answer to one event, proposal ID and revision: approve or veto; tied to the person's identity and time. A counter is a conversation message (ROOM-7), not an approval state. Selecting a candidate alone is not approval |
| Maneuver | The approved burn written to the operator's schedule, with the diff of what changes |
| Verification | The promised maneuver, the observations and comparison method, and a result: evidence consistent with the plan, mismatch, or awaiting sufficient data. It does not certify an exact burn from public element sets alone |
| Log entry | One immutable record of a step: time, who (agent or human), what was said or done, numbers before and after |
| Report export | An operator-scoped six-month summary and supporting event records, with counts, source coverage, verification status and missing information for review before regulatory reporting |

---

## 3. Lifecycle of a conjunction

The states below come from §6 and §7. The specification turns them into shared status values.

**Event**

```
new ──(yellow)──▶ stays in the feed and inbox; no prepared options in this build
 │
 └─(red)──▶ agents ──▶ proposal ──▶ communication ──▶ approved
                                                       ├─(maneuver)──▶ scheduled
                                                       └─(wait)──────▶ monitoring

scheduled ──(sufficient new data)──▶ verified / flagged (mismatch)
scheduled ──(insufficient data)──▶ awaiting verification data
awaiting verification data ──(sufficient new data)──▶ verified / flagged (mismatch)

new / agents / proposal / communication ──(updated data removes the risk)──▶ no action needed
agents ──(no mutually acceptable option)──▶ communication (needs operator decision)
proposal / communication ──(veto / counter / relevant discussion update)──▶ agents
approved ──(revised proposal before scheduling)──▶ communication
approved ──(Maneuver Scheduler refusal)──▶ agents
```

The verification branches apply after the maneuver time.

- **new** — the pair is in the queue.
- **agents** — the event turned red; Incident Analyst and Operator Advocates are working ("agents working").
- **proposal** — computed candidate proposals are ready; both owners see them in their queue and inbox, and the room is ready once an operator has started the workflow (DSP-1). If only one feasible candidate exists, or none, the room explains that instead of inventing alternatives.
- **communication** — the human operators compare proposals, select one for joint review, and discuss it by voice or text with translation. Agents follow both the voice transcripts and text messages, using relevant facts, constraints, preferences and corrections to revise the proposals. Each person can access the incident from their inbox even if the other person has not joined. They approve by ticking the checkmark, veto with a button, or counter in conversation; there is no structured counter form. In the bilateral path, one approval leaves the event in **communication**, identifying the candidate and revision awaiting the other side. In unilateral debris avoidance, the single required approval completes human authorization (ROOM-14).
- **approved** — all required sides for this workflow approved the same selection generation, proposal ID and revision for this incident (ROOM-14).
- **scheduled** — Maneuver Scheduler wrote the maneuver and the re-screen found no new conjunction.
- **monitoring** — all workflow-required operators agreed to wait; the decision and any agreed review time or condition stay visible in the inbox, and no maneuver is scheduled.
- **awaiting verification data** — the maneuver time has passed, but there is not enough new orbit data to determine whether the maneuver matched the promise.
- **verified** — after the maneuver time, sufficient observations are consistent with the promised maneuver ("evidence consistent with plan"), with the comparison and its limits visible.
- **flagged** — new orbit data does not match the promise; both sides are warned.
- **no action needed** — updated data shows the event no longer needs action; the history is kept. If a maneuver is already scheduled, it is flagged for review instead of changing state silently.

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

- **DATA-1** Pulls the public sources on a schedule: base catalog orbits (CelesTrak GP), operator-supplied orbits (CelesTrak SupGP), a reference conjunction list (CelesTrak SOCRATES), public conjunction messages (Space-Track `cdm_public`), historical element sets (Space-Track `gp_history`) for epoch-matched validation (SCR-3) and the verification replay (VER-3), and object metadata (KeepTrack) (§9). Keeps source URLs, object IDs, data epochs and fetch timestamps.
- **DATA-2** Keeps permitted local source snapshots and provenance for reproducible screening and replay without live source requests. Cached data does not provide shared room state, model calls or voice services. Fallback demonstrations follow SYNC-3 and SYNC-4.
- **DATA-3** Respects each source's limits: CelesTrak GP at most once per 2 hours per file; Space-Track 3 full-conjunction requests a day, 30 per minute, 300 per hour, with `gp_history` pulls counted against the same limits; KeepTrack 500 per hour. CelesTrak also blocks an IP address that uses more than about 100 MB a day or returns more than 50 HTTP errors (301 / 403 / 404) in 2 hours; venue Wi-Fi likely shares one public IP between teams. So each file is downloaded once per allowed interval and the team works from the local snapshot (DATA-2); a failed request is not retried in a loop.
- **DATA-6** Ingests orbits in OMM format (JSON or CSV) only, not TLE. CelesTrak ran out of 5-digit catalog numbers on 2026-07-11, and the TLE format cannot hold longer ones; SupGP already contains 9-digit IDs. Each record is parsed and propagated on its own: a record that fails is skipped and recorded, and never stops the whole load. Decayed objects and propagation results that are invalid are excluded so they cannot create false conjunctions.

**User**

- **DATA-4** Can trigger a manual refresh of the data from live sources.
- **DATA-7** Enters a simulated satellite ("Launch your satellite"): a prefilled orbit that crosses a chosen real catalog satellite at a chosen time (SCR-10). A demo run may contain two simulated US objects for the linked US/Russia and US/China encounters. Keep four assigned objects per dispatcher by replacing seeded slots explicitly. The form is behind a feature flag. Each simulated satellite gets:
  - a reserved ID outside the catalog's number ranges (for example `SIM-0001`);
  - fictional owner metadata (a made-up company name and country, for example Russia or China), assigned to the launching test operator's company; the other test operator is assigned the real target satellite as a simulated participant;
  - a simulated supplied Pc for its conjunction (a simulated CDM with value, epoch and source "simulated"), so the event can turn red under Q-2.

**Demo data**

- **DATA-5** Runs the demo on the demo week's real catalog snapshot, retaining sources and timestamps, and pins a reproducible cached copy. Simulated spacecraft (DATA-7) create the linked encounters against real catalog counterparts. Every derived event, proposal and log entry carries a `simulated` flag, a distinct color and a visible "simulated" label, and is excluded from validation (SCR-3) and real report counts (LOG-7). Real pairs enter a personal queue only when an assigned object is involved. Demonstration policies, participants and proposed maneuvers are identified as simulated. Historical maneuver verification is a separate, labeled replay. No simulated object or result is presented as real.

---

## 5. Screening and validation

**System**

- **SCR-1** Propagates each assigned active spacecraft against every other usable object in the selected catalog snapshot with SGP4 (deterministic code, not a model), including debris and own-fleet peers, and finds pairs that pass closer than 5 km in the 3-day horizon. Skips self-pairs and deduplicates unordered pairs. A separate reference validation run can have a broader scope; show its scope explicitly.
- **SCR-2** Computes TCA, miss distance and relative velocity, and attaches supplied Pc from a matching public CDM where available, or a labeled SOCRATES value. Matches object IDs, encounter time and data version; retains source, epoch and metric type, including whether the source reports a maximum probability. Missing Pc stays unavailable. Does not invent a probability or covariance, use fixed sigma, or reuse the original event's Pc as a post-maneuver estimate. The one exception is a simulated event (DATA-7): its supplied Pc is the scenario's simulated CDM value, flagged `simulated` and never shown as coming from a real source.
- **SCR-3** Validates detection over the complete SOCRATES reference list within the selected catalog coverage and horizon on one pinned snapshot. Matches by data timestamp: the validation run uses, for each object, the element set with the same epoch that SOCRATES used for that run. Newer orbit data moves objects by a kilometre or more, so comparing runs on different data measures the data difference, not the screening. Events where our input epoch differs from SOCRATES' are reported as "data differs", not as misses. Reports matched / eligible reference events, recall, matching tolerances, exclusions and unmatched events. Separately reports TCA and miss-distance error for matched events. Identifies verified input/element-set differences separately from screening misses; unexplained differences remain unresolved and in the reported denominator.
- **SCR-4** Computes the same conjunction from GP and SupGP where both are available and shows the two results and their min–max spread, with epochs. Labels this as source disagreement, not a calibrated uncertainty interval or probability range.
- **SCR-5** Compares SOCRATES with public CDMs; a pair listed in both, or flagged `EMERGENCY_REPORTABLE` in a CDM, gets higher priority.
- **SCR-6** Retired: risk forecasting is removed entirely. No trained model, persistence forecast, threshold-based forecast, forecast benchmark or predicted trend arrow replaces it. Historical observations remain available as history only.
- **SCR-7** Re-screens a single satellite against the whole catalog on demand (used by the Maneuver Scheduler, EXE-2).
- **SCR-10** Builds the simulated satellite's orbit for DATA-7: takes the chosen real satellite's orbit, rotates the orbital plane by a few degrees around the point where that satellite will be at the chosen time, and tunes the phase so both arrive there together. The result is propagated with the same SGP4 code, so screening, the globe and the re-screen agree with it. Chooses the geometry so that at least two feasible candidates exist.

**User**

- **SCR-8** Sees measured reference coverage and numerical agreement with the snapshot, scope, denominator and exclusions accessible. No fixed success count or percentage is hard-coded into the UI or pitch.
- **SCR-9** Sees both source distances, their range and epochs, supplied Pc provenance, and unavailable fields explicitly. Approximate maneuver geometry is labeled indicative; it is not an internally computed Pc.

---

## 5.1 Assigned fleet and manual scans

- **FLEET-1** Resolves a user's current assignments server-side. Empty fleets stay empty; no global fallback.
- **FLEET-2** Lists every assigned satellite with ID, current propagated position/time, orbit epoch, freshness, unique unresolved incident count and scan coverage, even when it has no incidents.
- **FLEET-3** Selecting a fleet member focuses the globe and filters My Incidents. Run Scan always scans the full assigned fleet and labels its scope.
- **FLEET-4** Seeds three demo dispatchers and a read-only observer based in Russia, the US and China, four assigned objects each. User country and language are separate from real spacecraft metadata. Assignments and participants are simulated.
- **SCAN-1** Pins server-resolved assignments/version, snapshot and start-to-start+72h window. Screens fleet-versus-catalog, skips self-pairs and deduplicates canonical encounters across users.
- **SCAN-2** Streams queued/running/completed/failed, phase, counters and coverage; reuses active duplicate requests. Manual screening does not bypass source fetch limits.
- **SCAN-3** Distinguishes complete-zero-result, partial, failed and never-scanned states. Keeps previous results labeled with their run time and reports exclusions and stale inputs.
- **ROOM-14** Bilateral active-spacecraft incidents require both assigned sides. Confirmed debris avoidance requires only the assigned active-spacecraft operator, with no fictitious debris approval; only that active spacecraft may move. Missing/unregistered active operators are not debris. Same-company active pairs remain visible for internal review with scheduling disabled until their approval rule is specified.

---

- **ROOM-15** Groups related pair events into a room with 2-4 operators. Membership grants only shared room projections. Event authority remains assignment-scoped; changes to shared trajectory inputs invalidate affected event approvals.
- **OBS-1** Provides a read-only authenticated large-display projection of the demo: globe, scan, public agent progress, shared proposals, and results, with no policy, private memory, or approval capability.

## 6. Conjunction queue

**System**

- **Q-1** Ranks only incidents involving the caller's assigned fleet. Known-current-evidence groups: red, yellow, then other usable-Pc events; within a group sort by earliest TCA, emergency flag, descending Pc and stable event ID. No Pc/time score or private-policy score. Missing/stale evidence appears in a separate always-visible Data needs review section, ordered by TCA then miss distance. Preserve last-known severity marked stale; unknown Pc is never zero risk. Follow-up cases stay visible separately (user-flow.md section 4).
- **Q-2** Colors events: **red** when Pc > 1e-4 and TCA < 72 h; **yellow** when Pc is between 1e-5 and 1e-4, or when Pc > 1e-4 and TCA ≥ 72 h.
- **Q-3** On red, starts the agents. The room is created when an operator starts the workflow (DSP-1). On yellow, stays in the feed and inbox with no prepared options in this build (section 20 Q9).
- **Q-4** Agents run only for the top of the queue, not for every pair.

**User**

- **Q-5** Sees My Incidents for their assigned spacecraft, including both involved fleet members on one deduplicated row when applicable: pair, time to conjunction, distance, supplied probability and source, status. Keeps the existing red/yellow and lifecycle presentation; no additional action-label system or heuristic dismissal feature is added.
- **Q-6** Sees an "agents working" mark on events where the agents are running.
- **Q-7** Sees on the row when a proposal is ready and opens the room from there (calls come later, DSP-2).
- **Q-8** Sees the outcome on the row afterwards: evidence consistent with the plan, a mismatch warning, or awaiting verification data.
- **Q-9** Opens a "Verify on CelesTrak" link from each row to the relevant source report or object data. The link identifies what it can verify, and the incident shows source timestamps. If an exact historical event link is unavailable, links to the actual available source without implying that it verifies OrbitCall's proposed maneuver.

### 6.1. Personal inbox

The working queue ranks conjunctions for the user's assigned fleet. Company-wide reports are separately authorized. The inbox gives each person a persistent place on the website to find the incidents and updates relevant to them, including those they could not resolve through a call or agent negotiation.

**System**

- **INBOX-1** Creates an inbox entry for each relevant person when a conjunction event concerns their satellites, another operator adds them to a coordination room, or they receive an affected-operator notice. The entry is available before a proposal or successful call.
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
- **AGT-2** Incident Analyst produces a five-line summary and multiple computed candidate proposals for joint human choice. Deterministic tools evaluate a small grid of moving satellite, burn time and delta-v; each card shows estimated geometry, available fuel estimates, assumptions and policy feasibility. Show up to four computed candidates total, including waiting with a review condition where appropriate. A simple along-track approximation may support the demo, but is labeled indicative and followed by the defined re-screen; it is not a production optimizer or proof of a target Pc. Insufficient data and fewer feasible candidates are shown honestly.
- **AGT-3** Operator Advocates A and B evaluate and discuss candidates within their private policies and can recommend a preferred candidate with a shareable explanation. Humans can compare alternatives and select one for joint approval; the agents do not choose or authorize a maneuver for them.
- **AGT-4** A relevant new fact, constraint, preference or correction from human discussion, a veto, a counter or a Maneuver Scheduler refusal makes the agents reconsider the proposal and recompute candidate outcomes as needed.
- **AGT-5** Every number in a rationale comes from computation, not generation; each explanation passes a deterministic check against the numbers before it reaches a person.
- **AGT-6** A second, independent model (Grok, text API) reads the rationale and flags disagreement to the humans in the room.
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

- **DSP-1** Starts the workflow on an incident (in the UI, Run agents on this case): creates the coordination room and joins every operator currently assigned to an involved object, including the other companies' operators, to the room and its call. Operators joined by someone else get an inbox notice and are not taken to the room screen; the room is an optional channel and deciding never requires opening it.
- **DSP-2** Later, not in the base build (question 6): finds and calls the two owners. For now starting the workflow joins both operators to the room (DSP-1), and each sees the notice in their inbox.
- **DSP-3** Later, not in the base build (question 7): finds operators whose satellites the proposed maneuver affects, and notifies them before the maneuver.
- **DSP-4** Gemini hosts the shared conversation, asks relevant clarification questions, requests checked revisions when discussion changes a plan, and produces source-linked per-event summaries. Convex records validated outputs in the log. Gemini receives only shareable room context and cannot create approval or alter schedule state directly.
- **DSP-7** Makes the incident and available operator contact methods accessible in each relevant person's inbox regardless of whether they answer the call or join the room.

**User**

- **DSP-5** Sees in the queue and inbox when a proposal is ready, sees whether the other operator is in the room (joined automatically, possibly left since), and can join or return to the incident through the inbox. Calls and invitations come later (DSP-2).
- **DSP-6** Later (question 7): as an affected third operator, receives a notice about the new path before the maneuver.

---

## 10. Conjunction room

**System**

- **ROOM-1** Holds group-room state: 2-4 participating operators, linked pair events, shareable summaries, negotiation, conversation, and call. Each event keeps its own proposals, selection generation, approvals, scheduling, and verification. The room closes when every linked incident is resolved (approved or later, or no longer active); a closed room stays readable.
- **ROOM-2** Schedules only when all required sides (ROOM-14) have current approvals for the same incident, selected proposal ID, revision and selection generation. Approving different alternatives does not reach agreement. If both approve a wait candidate, records it and moves to monitoring without a maneuver. A veto or conversational counter returns to negotiation.
- **ROOM-3** Shows each side only its own controls and private policy panel, with a visible privacy indicator, and translates shared lines into that side's language. The opposing policy is inaccessible, not merely hidden in the browser.
- **ROOM-11** Tracks approvals by incident, proposal ID, revision and selection generation. Selection changes and new revisions reset required approvals visibly, with bilateral or unilateral wording. The backend rejects stale approvals and rechecks current selection, revision, evidence, policy and fleet authorization before reserving the idempotent schedule write. Earlier approvals remain historical and cannot be revived by switching back. Changes to an already scheduled maneuver remain proposed changes until explicitly approved.

**User**

- **ROOM-4** Sees both orbits, the conjunction point and a countdown to TCA.
- **ROOM-5** Compares candidate cards: proposal ID/revision, who moves, when, delta-v, estimated fuel where available, computed distance before → after, assumptions and shareable feasibility. Can select a candidate for joint review; selection alone does not approve it.
- **ROOM-6** Writes to room participants in persistent chat and can join the optional shared LiveKit call. Messages identify the relevant incident when needed. English, Russian, and Mandarin are supported.
- **ROOM-7** Approves the selected candidate revision only by ticking its checkmark. Required sides decide in turns, side A then side B; only the side in turn can approve, veto or change the selection while the decision is open. Agreement requires all sides defined by ROOM-14, separately for each incident. Vetoes with a button, or counters through ordinary voice or free-text conversation. No separate structured counter-proposal fields are built. Speech never approves.
- **ROOM-8** Sees candidate/revision-specific status: "P2 · R2 · A approved · waiting for B," a visible reset when it changes, and separate approval, re-screen and scheduling results.
- **ROOM-9** Sees the maneuver diff (what will change in the schedule) before approving.
- **ROOM-10** Sees a chart of historical supplied Pc or miss distance with source timestamps. It contains observations only, without a forecast curve or predicted trend.
- **ROOM-12** Sees the facts, hard constraints and preferences the agents understood from shared discussion, plus shareable policy outcomes/categories under POL-2, and an explanation of each proposal revision. Can correct those interpretations in the conversation; private policy values are not added to the shared view.
- **ROOM-13** When the last operator leaves the call, or when someone asks, the Coordination Host posts a room summary and can read it aloud. Room members receive a notification. Each linked incident shows its own selected candidate revision and approval form. Only its required operators can approve it (ROOM-7, ROOM-14). An accepted edit publishes a checked new revision and resets that incident's affected approvals (ROOM-11). A summary never approves a plan.

---

## 11. Translation and voice

**System** (§8)

- **LANG-1** Recognizes speech as a stream, phrase by phrase, in each participant's language, including Russian.
- **LANG-2** Translates voice transcripts and text with room context while protecting numbers, units, signs, dates/times, time zones and satellite IDs as typed placeholders. Restores them after translation from the authoritative proposal revision for proposal text, or the original message for human speech/text, including newly suggested values. Checks placeholder integrity before display or speech; retries or shows the original if validation fails. Does not replace a new conversational value with an older card value or ask the model to invent one. Ambiguous speech recognition is clarified before it changes a proposal.
- **LANG-3** Delivers each phrase to the listener as voice and text in their language; the speaker sees their original in the transcript.
- **LANG-4** Feeds transcribed voice and posted text messages into the agents' conversation context, retaining the speaker, original wording and translations. Relevant facts, hard constraints, preferences and corrections can trigger a revised proposal (AGT-11..AGT-13).
- **LANG-5** Writes both language versions of every phrase to the log.
- **LANG-6** Gives the Coordination Host a voice, including reading the end-of-call summary (ROOM-13). Speech, translation or a casual acknowledgement never creates an approval; only the checkmark does (ROOM-7).
- **LANG-7** Works in text only when voice is unavailable, with the same translation.

**User**

- **LANG-8** Speaks and reads in their own language and can open the original wording beside a translation in one click.

---

## 12. Execution

**System** (§5, §6)

- **EXE-1** After the workflow-required operators (ROOM-14) approve the same selection generation, proposal ID and revision and its re-screen passes, writes that exact maneuver to the operator's schedule file, `operators/<operator>/schedule.json`, through Factory Droid in a run-isolated workspace. Before approval, Droid prepares the change and the room shows its checked diff (EXE-4, ROOM-9). A Convex transaction rechecks approvals and inputs and reserves an immutable write intent. The worker writes exactly that change with access limited to the schedule workspace. Convex keeps the maneuver record, artifact reference and diff. Factory failure stays visible and retries the same intent, without an automatic substitute writer. Retries cannot create duplicate schedule entries. See the master roadmap for the external-write and trajectory-version contract.
- **EXE-2** Re-screens the moved satellite against the whole catalog, not only against its partner.
- **EXE-3** If the re-screen finds a new conjunction, refuses and returns to negotiation with that as a constraint.
- **EXE-4** Before approval, Droid prepares the diff of what will change, for the room (ROOM-9).

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
- **LOG-7** Generates an operator-scoped six-month report draft from canonical incident records; simulated events (DATA-5) are excluded. Includes reporting period, satellites covered, unique conjunction count, events with operator coordination, events with maneuvers, unresolved events, and supporting incident references. Separates planned/scheduled maneuvers from observed or operator-confirmed execution; overlapping coordination/maneuver categories are not added as disjoint totals. Revisions and repeated alerts do not count as new events. Shows missing source coverage and unresolved event matches explicitly.
- **LOG-8** Supports a reviewed mapping to the applicable FCC space-system safety report requirements (S3's target: FCC 26-47, §100.201(d)). Keeps rule/version, reporting-period definition and field provenance with the export. Marks required fields outside OrbitCall's data as missing and allows explicit operator-supplied values with provenance before export. Does not invent zero counts, auto-file a report, or claim complete regulatory compliance from a partial log; current applicability, effective dates and final field mapping must be verified before a filing-ready template is released.

**User**

- **LOG-4** Reads the log for an event or across events.
- **LOG-9** Selects their operator and reporting period, previews the counts, coverage and missing fields, and downloads the report draft with a CSV of its supporting event records. Reviews and completes information before using it for reporting; private policy values are excluded.

---

## 15. Identity and sides

**System**

- **ACC-1** Each person signs in as an operator of their company with explicit server-managed responsibility assignments for individual spacecraft. Assignments do not confer ownership and country/language confer no permissions. Accounts are pre-created test users, three required for the main demo and an optional fourth operator, with four assigned objects per enabled demo dispatcher. There is no registration. Login goes through Auth0 with sign-ups disabled, and Convex verifies the identity. An identity-provider change requires a recorded stack revision and another authorization check.
- **ACC-2** An approval is tied to the authenticated person, company, current fleet authorization, incident, proposal ID, revision and selection generation. Every approval and schedule commit rechecks the assignment. Revocation invalidates affected approvals. The server authorizes each read and write, including live subscriptions and report exports; changing a browser role label cannot expose another company's policy or approve for it.
- **ACC-3** The same screens serve both companies; content and controls depend on whose side the viewer is on.
- **ACC-4** Roles: an operator sees their company's policy, inbox and the rooms of their events, and approves; a head of operations reads their company's log, reports and the rooms of company incidents, and cannot approve, start a workflow, join or post; an affected third operator sees only the notice in their inbox. The main demo has three dispatcher accounts with assigned fleets and a separate read-only observer. Group rooms support 2-4 operators linked through pair events. A group member can discuss shared context but approves only their own incident side. This is distinct from deferred outreach to unrelated affected parties.

---

## 16. Live updates and resilience

**System**

- **SYNC-1** All state (events, policies, rooms, messages, proposals, approvals, inbox entries and per-person read status, log) lives in one source of truth.
- **SYNC-2** Changes appear on every open screen at the same time, without reloading.
- **SYNC-3** Keeps a tested fallback demonstration using cached Dev-mode data and a labeled recording of the shared cloud workflow. This replaces the earlier unimplemented promise of a self-hosted LAN backend. A future local shared backend must preserve the same company access controls and approval rules and requires a recorded stack change.
- **SYNC-4** Without internet, only tested local Dev-mode features remain available. Shared Convex rooms, cloud voice, model-driven negotiation and translation require their services. A labeled recording may demonstrate those parts without pretending to be a live update or a fresh approval.

---

## 17. Agent runtime

Fetch.ai (uAgents, Agentverse, ASI:One) was dropped on 2026-10-24: its prize requires the whole workflow to run inside an ASI:One chat without our interface, which does not fit a two-operator room. Agents run inside our own backend instead.

**System**

- **EXT-1** Each system role runs as a separate agent inside our backend service: its own instructions, its own context, and access only to the data its role allows. Each Operator Advocate sees only its own company's policy (POL-2).
- **EXT-2** Operator Advocates negotiate by exchanging real messages through our backend. Every message is stored with the rest of the incident state (SYNC-1), so both rooms can show the negotiation live and the log keeps it (LOG-2).
- **EXT-3..EXT-6** Retired with Fetch.ai: no ASI:One workflow, no interactive cards, no second demo. There is one demo, the two-laptop conjunction room.

---

## 18. Screens

Which functions each screen shows (§7).

| Screen | What's on it | Functions |
|---|---|---|
| 1. Assigned-fleet dashboard | My Fleet list with current propagated positions and freshness, fleet-highlighted globe, filtered My Incidents queue, Data needs review and follow-up sections, fleet-scoped Run Scan and coverage, measured reference coverage and numerical agreement, source links, refresh, "Launch your satellite" form (feature flag) with simulated objects in a distinct color | Q-5..Q-9, SCR-8, DATA-4, DATA-7 |
| 2. Conjunction room | Orbits and countdown, summary, shareable negotiation, always-on chat with an optional live call, candidate comparison and selection, revisions and visible approval resets, approval checkmarks / Veto / conversational Counter, end-of-call summary form, both sides' status, own-policy privacy indicator, maneuver diff, historical observations, second-model disagreement flag | ROOM-3..ROOM-13, AGT-6, AGT-8, AGT-9, LANG-8, SCR-9 |
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
- Fetch.ai integration (uAgents, Agentverse, Agent Chat Protocol, ASI:One chat or cards); dropped 2026-10-24 (section 17).
- Unrelated operators entering a room or approving an incident they do not own. A third/fourth company involved in a linked event is an authorized group-room participant under ROOM-15.
- Spoken approval: approval is only a checkmark (ROOM-7).

---

## 20. Open questions for the specification

The accepted decisions below retain the original question numbers so existing references remain meaningful. Remaining details belong in the specification.

1. **Resolved — screening horizon:** 3 days ahead.
2. **Resolved — Risk Monitor cadence:** every 5 minutes over cached data; source fetch limits (DATA-3) are unchanged.
3. **Resolved — proposal choice:** up to four computed candidates when feasible, with explicit shared selection followed by the workflow-required independent approvals of the same candidate revision (S1, ROOM-14).
4. **Resolved — Counter:** voice and free text feed automatic revisions; no structured counter form (M3 skipped).
5. **Resolved — policy visibility:** raw policy values are private to the company and its Operator Advocate; shared outcomes/categories and the proposed maneuver are visible (M2).
6. **Deferred — calling people:** the base build does not call or invite anyone; both operators see the event in their queue and inbox and open the room themselves. Contact details stay visible in the inbox (INBOX-4). Idea for later: click a satellite to send a message to its operator.
7. **Deferred — unrelated affected-party notice:** outreach to an operator who is not involved in a linked pair event is outside the base build. This does not limit the accepted 2-4 operator group room for linked events.
8. **Resolved — event identity:** the unordered object-ID pair (NORAD numbers for catalog objects, the reserved `SIM-` ID for the simulated satellite) plus |ΔTCA| ≤ 60 s.
9. **Resolved — yellow events:** this build prepares no options for yellow events; they stay in the feed and inbox only (Q-3's "may" is not used).
10. **Resolved — reporting template:** an on-screen summary plus a CSV of supporting event records. FCC fields are shown as "to verify"; there is no filing-ready template in this build (S3).
11. **Resolved — evidence methods (demo-first defaults):**
    - Candidate grid: moving satellite A or B × burn time T−12 h, T−6 h or T−3 h × along-track Δv 0.02, 0.05, 0.1 or 0.2 m/s, plus a wait candidate. Up to four computed candidates are shown with fuel/geometry tradeoffs and explicit feasibility. Do not manufacture alternatives. Geometry uses Δa ≈ 2·Δv/n and is labeled indicative.
    - Re-screen passes when the original pair's new miss distance is at least 1 km and no other catalog object comes within 1 km of the moved satellite over the 3-day horizon; otherwise EXE-3 refuses.
    - Verification: a series of at least 8 element sets; semi-major-axis changes scored with a robust z-score (median and MAD); a change counts when |z| ≥ 5 and |Δa| ≥ 50 m. "Evidence consistent with plan" when the sign matches and the size is within ±50% of the expected 2·Δv/n; fewer than 8 sets means "awaiting verification data". No post-maneuver Pc is substituted (S1, M7, M8).
12. **Resolved, amended — priority and missing Pc:** severity first, then nearest closest approach. Missing/stale evidence belongs in a separate visible Data needs review section, sorted by TCA then miss distance. Retain last-known severity as stale; missing Pc is never zero risk. This supersedes the previous missing-Pc-at-bottom rule (Q-1; user-flow.md section 4).
13. **Retired — ASI:One identity:** no longer applies; Fetch.ai and the ASI:One workflow were dropped (section 17).
14. **Resolved — schedule history:** each authorized artifact has a checked Factory diff and Git commit in a run-isolated schedule workspace. Convex stores the job, reserved intent and artifact reference. The master roadmap defines the retry and version checks.
15. **Resolved — leaving monitoring:** at the agreed review time, or when new data changes the event's color or miss distance, the Risk Monitor returns the event to the agents and both owners see it again in their queue and inbox.
16. **Resolved — after a veto:** the selected candidate stays selected, required approvals reset, the agents revise (AGT-4) and the event returns to communication with a new revision or the remaining candidates.

**Later, after the base works:** calling and inviting operators (DSP-2), including "click a satellite to message its operator"; third-operator notices (DSP-3, DSP-6); the details of schedule history (question 14). The base starts at My Fleet and Run Scan, then the incident room: chat, optional call, agents, end-of-call summary and workflow-specific approvals.
