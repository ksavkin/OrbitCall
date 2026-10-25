# OrbitCall — Feature analysis and decisions

Originally written Oct 24, 2026, ~00:40 PT (H≈4 of the hackathon). Updated Oct 24 after product review. This document now records the accepted and skipped recommendations; [functionality.md](functionality.md), [plan-v1.md](plan-v1.md) and the [README](../README.md) reflect those decisions. They describe planned behavior, not implemented features.

## Runtime mode decision (October 24)

The user confirmed: Dev on keeps the working TLE catalog and synthetic conjunction scenarios. Dev off is the real mode and requires backend OMM, with no silent TLE or simulation fallback. Until the OMM backend and frontend integration are ready, show an explicit unavailable/integration-pending state. This applies in both Git branches; `main` is not a runtime data mode. CelesTrak remains the source. OMM is an exchange format, not an automatic improvement in orbit accuracy. It supports larger object IDs and avoids legacy TLE format limits. See [CelesTrak format documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php).

## How the original analysis was made

- **Inputs:** three research notes kept locally, not included in this repository: `features_commercial.md` (~27 commercial/government products), `features_github.md` (open-source projects and libraries), and `hackathons.md` (projects across 54 events).
- **Reviewers:** the author plus three independent model reviews (`hy3`, `glm-5.3-flash`, `deepseek-v4-flash`). Their votes were recommendations, not validation of market uniqueness or implementation feasibility.
- **Estimates:** the original rough backend/frontend hour estimates preceded these decisions. Re-estimate against the updated build plan; they are not delivery commitments.
- **Evidence boundary:** competitor comparisons cannot be fully checked from this repository because the research notes are absent. Do not turn “not found in the reviewed products” into a claim that no commercial product supports a capability.

The latest locked scope, stack, phases, and deployment are in [master-roadmap.md](master-roadmap.md). It supersedes older provider alternatives and pair-room-only assumptions in this decision history.

The user approved a third agent provider in master roadmap v1.1. Gemini takes the Coordination Host role. Claude retains incident analysis, private advocates and translation. Grok retains independent rationale checking and selected audio tasks. This replaces the earlier all-Claude host assumption and requires a real Gemini API result before any Best Use of Gemini API claim.

## Current workflow amendment: assigned fleet (October 24, 2026)

The user approved [the fleet-first workflow](user-flow.md): My Fleet + personal incident queue + globe, with four assigned spacecraft per enabled demo dispatcher, three demo dispatchers based in Russia, the US and China, a read-only public display, and support for a fourth operator. Identity and assignment determine access; country does not. Run Scan screens the caller's assigned fleet against every other usable object in the pinned catalog over the next 72 hours. It does not populate a global operator queue.

Priority is severity first, then earliest time of closest approach within each group. Missing/stale evidence has a separate visible Data needs review section. This supersedes Pc/time scoring and the old rule putting every missing-Pc event at the bottom. TCA means Time of Closest Approach; the UI explains it as "Time until closest approach".

Shared candidate selection is separate from each operator's Approve. Show up to four computed candidates, including wait when justified. Counter remains a conversation message, not a separate approval status. Two participating active-spacecraft operators each approve; confirmed debris uses a distinct unilateral path requiring the assigned active-spacecraft operator, never an invented approval for debris. Missing active operators do not qualify for that exception. Earlier references to both approvals below describe the bilateral path.

## 0. Decision summary

| Item | Decision | Result |
|---|---|---|
| M1 | **Accept** | Bilateral: both humans approve the same proposal ID and revision; debris: only the assigned active-object operator approves; selection changes reset required approvals |
| M2 | **Accept** | Company policy values are private throughout data access, agent context, UI, logs and exports |
| M3 | **Skip** | No structured counter-proposal form; keep ordinary voice/text counters and automatic agent revisions |
| M4 | **Accept** | Protect technical values during translation, restoring them from their authoritative source |
| M5 | **Accept, amended Oct 24** | A pinned real catalog snapshot with provenance. Two flagged simulated US spacecraft may create the linked US/Russia and US/China encounters, each against a real catalog counterpart |
| M6 | **Already done** | Keep the chosen clear role names |
| M7 | **Accept** | Shared promised-versus-observed verification with evidence, method and pending-data state |
| M8 | **Accept with the reviewed evidence limits** | Supplied Pc with event/version provenance; source spread is not statistical uncertainty; no invented internal Pc |
| M9 | **Remove forecasting completely** | No trained forecast, replacement baseline, forecasting rules, benchmark or predicted trend arrow |
| M10 | **Accept** | Measured coverage over the full eligible reference snapshot, separate numerical errors and transparent input differences |
| S1 | **Accept — decision between multiple proposals** | Humans compare up to four calculated candidates, select separately from approval, and the workflow's required operators approve the exact revision |
| S2 | **Skip — ask again** | No saved pair agreement or standing authorization; every new incident asks both operators again |
| S3 | **Accept** | Operator-scoped six-month report draft and supporting event export, with reviewed FCC mapping and coverage |
| S4 | **Skip** | Keep existing severity/lifecycle presentation; no additional action-label taxonomy |
| S5 | **Skip** | No heuristic dismissal feature based on co-orbiting, same launch or relative speed |
| S6 | **Accept** | Relevant CelesTrak source link on every queue row |

The original analysis's separate cut list and interface suggestions were not automatically accepted by this selection. Their status is recorded below.

## 1. Accepted requirements and implementation meaning

### M1 — Approvals identify one plan

Each approval identifies the incident, selected proposal ID and immutable revision, plus the authenticated operator and time. Both must match. Selecting a candidate is not an approval, and approvals of different candidates cannot be combined.

A new selected candidate or revision visibly clears both approvals, for example: “P2 · R2 created — both approvals reset.” Returning to an older selection does not revive an old approval. Material changes to policy inputs, constraints or orbital evidence invalidate affected approvals; unrelated conversation does not. The backend rejects stale approvals and checks both authorizations against the current selection before committing the schedule. A scheduled maneuver is flagged for review, never silently replaced.

**Functions:** ROOM-1, ROOM-2, ROOM-5, ROOM-7, ROOM-8, ROOM-11, ACC-2, EXE-1, LOG-2, LOG-6.

### M2 — Private company policy

Only authorized company users and their Operator Advocate receive raw policy values. The opposing company, Incident Analyst and Coordination Host receive shareable candidate outcomes or categories such as “fuel” or “mission window.” The actual proposed maneuver parameters remain visible to both humans; the private limits used to evaluate them do not.

Enforce the boundary in API/database access, live subscriptions, model context, negotiation messages, UI, shared logs and exports. A hidden UI panel alone is insufficient. Keep shareable contacts and language separate from private operational policy. Private past-incident memory is context only and cannot authorize a later event.

**Functions:** POL-1, POL-2, POL-6, POL-7, AGT-1, AGT-3, AGT-7, AGT-8, ROOM-3, LOG-1, ACC-2.

### M4 — Preserve values through translation

Protect numbers, units, signs, dates/times, time zones and satellite identifiers with typed placeholders before translating the surrounding language. Restore and check values before display or speech. For proposal content, use the exact proposal revision; for human messages, use the original message, including newly introduced numbers. Never replace a new spoken counter with an older card value.

Retain original wording and speaker identity. A failed placeholder check retries or falls back to the original; ambiguous speech recognition is clarified before changing a plan. Approval is only a checkmark on the current candidate revision; speech never approves (amended at the final review).

**Functions:** LANG-1..LANG-8, ROOM-7, AGT-11..AGT-13.

### M5 — Real catalog, traceable demo

Pin the demo week's real catalog snapshot, retaining source URLs, object IDs, epochs and fetch times. Use actual source/computed values in the presentation. Label demonstration policies, participants and proposed actions as simulated. A sourced historical verification replay is separate from this current event; do not present it as proof that the live demo's proposed maneuver occurred.

**Amended for the locked demo (Oct 24):** the team cannot rely on a suitable real encounter during judging. The linked three-operator story may use two simulated US spacecraft, each with a computed orbit crossing a real catalog counterpart at a chosen time. Keep four assigned spacecraft per dispatcher. Simulated objects and everything derived from them carry a `simulated` flag, a distinct color and label, and are excluded from validation and real report counts. No simulated object or result is presented as real. See the master roadmap for the complete scenario.

**Functions:** DATA-1, DATA-5, DATA-7, SCR-10, VER-3; plan sections 4, 7, 9 and 13.

### M7 — Promised versus observed

The Maneuver Verifier records the agreed candidate/revision beside later observations, with sources, epochs, method, thresholds and limitations. The demo method examines semi-major-axis or mean-motion changes against the object's own noise baseline using a time series, then compares the direction and approximate size with the expected change from deterministic tools.

A single element-set jump does not prove exact delta-v or execution time. Results are evidence consistent with the plan, mismatch, or awaiting sufficient data. Sparse, noisy, stale or conflicting data stays pending; a scheduled maneuver is not automatically an executed maneuver. Use a sourced historical event such as an ISS reboost or documented Starlink maneuver for the replay.

**Functions:** VER-1..VER-4, LOG-2, INBOX-3, INBOX-5; plan sections 6, 9 and 12.

### M8 — Probability and source spread

Prefer supplied Pc from a matching public CDM, with labeled SOCRATES values as available. Match object IDs, encounter time and data version; keep source, epoch and metric definition, including maximum probability where applicable. Missing values remain unavailable, never zero risk. The original event's Pc is not automatically a post-maneuver Pc.

Display GP and SupGP results and their min–max range as **source disagreement**, not a calibrated uncertainty interval. Use no invented covariance, fixed sigma or internally generated Pc. This adopts the reviewed correction to the original suggestion of an “indicative Pc”: approximate candidate geometry may be labeled indicative, but that label does not justify making up a probability.

**Functions:** SCR-2, SCR-4, SCR-5, SCR-9, Q-1, INBOX-3, AGT-2.

### M9 — Forecasting removed

Remove the entire risk-forecasting feature, including the ESA Kelvins training/data dependency, prediction model, persistence baseline, threshold-based forecast, forecast benchmark and predicted trend arrow. Do not replace the trained model with another forecast. SCR-6 stays as a retired ID so references are not reassigned.

The queue uses current supplied evidence. Historical probability and distance observations can still be plotted, with source timestamps; they are history, not a prediction. Deterministic orbital propagation for conjunction screening remains in scope.

**Functions:** SCR-6 retired; Q-1, Q-5, ROOM-10, DATA-1 and Risk Monitor responsibilities updated.

### M10 — Measured and reproducible validation

Evaluate detection recall over the full eligible SOCRATES reference set for a pinned snapshot, selected catalog and horizon. Show matched / eligible counts, scope, tolerances, exclusions and unmatched events. Report encounter-time and miss-distance errors separately from coverage.

Identify evidenced element-set/input differences separately from screening misses. Unexplained discrepancies stay unresolved and in the reported denominator. Do not hard-code a success count or compare percentages from other projects without comparable inputs and evaluation methods.

**Functions:** SCR-3, SCR-8; plan sections 4, 7, 9 and 13.

### S1 — Humans decide between multiple proposals

Generate a bounded grid of moving satellite, burn time and delta-v through deterministic tools. Show up to four computed candidates, including waiting with a review condition when appropriate. Show who moves, time, delta-v, estimated fuel where available, computed geometry, assumptions and shareable policy feasibility. If only one or no feasible candidate exists, state that; do not manufacture alternatives.

Agents can recommend a candidate and update options from ordinary voice/text discussion. Humans compare, select and both approve one exact candidate revision. A simple along-track approximation can illustrate the demo with stated assumptions, but it is not a production optimizer or proof of a numerical Pc target; the selected maneuver still goes through the defined catalog re-screen.

**Functions:** AGT-1..AGT-4, AGT-8, ROOM-1, ROOM-2, ROOM-5, ROOM-7, ROOM-11, EXE-1..EXE-4.

### S3 — Report draft from the log

An authorized operator selects a six-month reporting period, previews the report and downloads a draft plus supporting event CSV. Include operator/satellite scope, unique conjunction count, events with coordination, events with maneuvers, unresolved events, provenance and source coverage. Revisions/repeated alerts are not separate events. Coordination and maneuver categories can overlap. Separate planned/scheduled maneuvers from observed or operator-confirmed execution; unresolved event matches and missing coverage are explicit.

Target a reviewed mapping to the FCC space-system safety report referenced in the original proposal as **FCC 26-47, §100.201(d)**. Verify the final rule, applicability, effective dates, reporting-period definition and required fields before releasing a filing-ready template. Preserve the mapping version. Fields outside OrbitCall's incident data require explicit operator-supplied information and provenance; never invent zero counts or assume a partial log covers the entire fleet. Export excludes private policy values and does not file automatically.

The [2025 FCC proposal](https://www.govinfo.gov/content/pkg/FR-2025-12-05/html/2025-22019.htm) documents the reporting concept; the [July 2026 draft](https://docs.fcc.gov/public/attachments/DOC-422740A1.pdf) is further research context. Neither substitutes for verifying the final rule and current applicability. The final-order PDF could not be retrieved during this documentation update, so a compliant field mapping is not claimed.

**Functions:** LOG-7..LOG-9, ACC-2; plan sections 6, 7, 12 and 13.

### S6 — Source links

Every queue row provides a “Verify on CelesTrak” link to the relevant report or object data, with source timestamps in the incident. If the exact historical event is not addressable, label the available source accurately. The link verifies source information, not OrbitCall's proposed maneuver.

**Functions:** Q-9, DATA-1; plan sections 6, 7 and 9.

## 2. Skipped recommendations

| Item | What is excluded | What remains |
|---|---|---|
| M3 | Structured counter fields for who moves, earliest/latest time, maximum delta-v or fuel | Voice and free-text counters, with agent interpretation, clarification and automatic candidate revisions |
| S2 | Saved agreements or standing rules for a satellite pair, including automatic authorization of later events | Explicit company policies and incident history can inform negotiation; every new incident and revised selected plan asks both humans again |
| S4 | Additional “No action / Wait for update / Plan mitigation / Coordinate” queue taxonomy | Existing red/yellow severity, lifecycle states and unresolved inbox situations |
| S5 | Heuristic dismissal rules or a dismissed-row feature based on same launch, co-orbiting or relative speed | Normal event identity/deduplication and evidence-based updates; a source update may still show no action currently needed |

**M6 remains complete:** Risk Monitor, Incident Analyst, Operator Advocate, Coordination Host, Maneuver Scheduler, Maneuver Verifier.

## 3. Other original cut recommendations — not adopted by this decision

The latest selection did not authorize the following separate cuts. Existing functionality remains as documented, including optional sponsor-related capabilities; their priority can still follow plan section 13.

| Original suggestion | Current status |
|---|---|
| Cut a second model checking explanations (AGT-6) | Not selected; Grok (text API) checks each rationale and the room shows a disagreement flag; deterministic checks remain required |
| Cut agent memory between incidents (AGT-7) | Not selected; memory remains context only, restricted to its company and never standing authorization |
| Cut third-operator notices (DSP-3, DSP-6) | Deferred at the final review: not in the base build; later an inbox notice. Joining the room or objecting is out of scope. Never describe an unbuilt invitation as working |
| Limit outreach to in-app only (DSP-2 partial) | Deferred at the final review: the base build calls or invites no one; operators open the room from their queue and inbox. Idea for later: click a satellite to message its operator. The inbox always retains available phone/email/contact instructions |
| Cut local-backend/LAN fallback (SYNC-3 partial) | Not selected; the local Convex backend over LAN is tested in plan section 13 (H24–H30). Cached data alone does not replace unavailable cloud services |
| Defer production orbit exchange, covariance Pc, full optimization and other large integrations | Existing out-of-scope boundaries remain. A bounded candidate comparison under S1 does not promise a production optimizer |

Fetch.ai (Agentverse, ASI:One) was dropped on Oct 24, 2026; agents run in our own backend. Other optional sponsor work retains the existing plan status. A role-switch URL can illustrate a simulated UI but cannot satisfy M2's privacy or ACC-2's authorization requirements.

## 4. Positioning and interface

The main screen is now explicitly My Fleet + My Incidents + globe. Public catalog exploration is contextual. The accepted fleet workflow supersedes earlier global-search presentation. Research, sources and acceptance scenarios are retained in [user-flow.md](user-flow.md).

Emphasize the connected workflow: private policy evaluation → human choice among computed proposals → voice/text discussion changes options → both approve the same revision → later evidence compared with the agreement → reviewable report draft. Retain the personal inbox for nonresponse, no agreement, monitoring, updated evidence and pending verification.

The original review suggested a room-first demo and a smaller globe. That presentation suggestion was not separately approved here; the updated plan follows the full queue/inbox-to-room workflow and makes candidate choice, private-policy boundaries, approval resets and original/translated text visible. No separate mockup brief is present in this repository.

Contact directories, rooms, logs, maneuver recommendations and screening comparisons should not be pitched as individually unique. The absent research notes do not substantiate a market-wide exclusivity claim for the full workflow either; describe the product's concrete behavior.

## 5. Resolved and remaining specification questions

Preserve the original numbers in [functionality.md section 20](functionality.md#20-open-questions-for-the-specification):

- **Q3 resolved:** up to four computed proposals for human choice when feasible, without fabricated alternatives.
- **Q4 resolved:** counters are voice/text; no structured form.
- **Q5 resolved:** company policy values are private; share outcomes/categories and proposed maneuver parameters.
- **Q1 and Q2 resolved:** 3-day screening horizon; Risk Monitor every 5 minutes over cached data, respecting source limits.
- **Q6 and Q7 deferred:** the base build calls no one and sends no third-operator notices; both come after the base works.
- **Q8 resolved:** event identity is the unordered NORAD pair plus |ΔTCA| ≤ 60 s; required for deduplicated reporting.
- **Q9–Q16 resolved at the final review** with demo-first defaults: no prepared options for yellow events; report = on-screen summary plus CSV; candidate grid, re-screen and verification thresholds; missing-Pc ordering; git-style schedule history; leaving monitoring; after a veto. See functionality.md section 20.
