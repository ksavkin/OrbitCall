# OrbitCall — Features

Feature list derived from [plan v1](plan-v1.md). Each feature has acceptance criteria, a priority and a milestone.
Nothing here goes beyond the plan; section references (§) point to it.

## Priority and milestones

Priority comes from the cut order in §13 (bottom items are cut first):

| Priority | Meaning | Cut order items |
|---|---|---|
| **P0** | Never cut; this is the demo | 1. Queue on live data + validation number · 2. Room with agent negotiation and two approves · 3. Changing a policy changes the outcome |
| **P1** | Cut only if far behind | 4. Voice call in two languages (at least STT → Claude → TTS) · 5. Executor with diff and re-screening |
| **P2** | Strong extras | 6. Verifier on a historical maneuver · 7. Globe · 8. Fetch.ai Agentverse registration and Chat Protocol |
| **P3** | Cut first | 9. Grok Voice instead of the STT/TTS chain · 10. Tiger, Backboard, Auth0, Factory, second model |

Milestones (§13): **H6** queue is live, Analyst writes a summary · **H14** end-to-end pass in text (minimum submittable version) · **H24** voice works or everything else freezes · **H30** feature freeze.

---

## 1. Data and screening

### F1. Catalog ingest and cache — P0 · H2 · Andrew

Pull the open sources and keep a local snapshot so the demo runs without network (§9).

- Sources: CelesTrak GP, CelesTrak SupGP (starlink, oneweb, planet), CelesTrak SOCRATES CSV, Space-Track `cdm_public`, KeepTrack `/v4/sats/brief`, ESA Kelvins CDM dataset.
- The snapshot is committed to the repo on Friday evening and refreshed at 8:00 Sunday.
- Live fetch is a "refresh" button, pressed only on working Wi-Fi.
- Respects source limits: CelesTrak GP no more than once per 2 hours per file; Space-Track 3 full-conjunction requests a day, 30/min, 300/hour.

### F2. Screening — P0 · H6 · Andrew

Find close pairs with deterministic code, not a model (§5, §6).

- Propagates active objects with SGP4 and finds pairs closer than the threshold.
- For each pair stores distance, time of closest approach (TCA) and probability (Pc taken from SOCRATES / CDM; we don't compute true Pc with covariances).
- Results are written to the `events` table.
- Open: the plan says 7 days ahead (§6 system flow) and 3 days ahead for the first build (§13 H2–H6).

### F3. Validation against SOCRATES — P0 · H14 · Andrew

The number that proves screening works (§9, §7).

- Takes SOCRATES' top 50 and counts how many our screening finds within 500 m and a few seconds of TCA.
- The match count is shown in the corner of the ops board ("Validated vs SOCRATES: N/50 within 500 m").
- The number shown is the measured one; "47/50" in the pitch script is a target.

### F4. Source cross-checks — P2 · H14 · Andrew

- **GP vs. SupGP:** the same conjunction on both orbit sets; the distance difference is shown as the uncertainty ("US data says X m, operator data says Y m").
- **SOCRATES vs. public CDMs:** a pair present in both gets higher queue priority; the CDM `EMERGENCY_REPORTABLE` flag also raises priority.

### F5. Queue ranking and colors — P0 · H6 · Kostya (Scout) + Adil (UI)

- Sort key: probability divided by hours to TCA, adjusted for fuel and risk forecast.
- **Red:** Pc > 1e-4 and TCA < 72 h — wakes the agents and the humans.
- **Yellow:** Pc between 1e-5 and 1e-4 — goes to the feed; agents may prepare options; humans are not bothered.
- A row's status moves through: new → agents → proposal → approved → verified.

### F6. Risk forecast ("risk will rise or fall") — P2 · Andrew

- Gradient boosting on the ESA Kelvins dataset (103 features, target = final risk). No LLM.
- Shown as a "risk rising / falling" arrow in the queue.
- Included only if it beats the naive rule "current risk = final risk" on the Kelvins test set; otherwise left out and we say so.

---

## 2. Agents

All reasoning agents run on Claude (Sonnet by default, Haiku for Scout). Agents read, compute, propose, call, translate and write a file. None of them can act on a satellite (§10, §12).

### F7. Scout trigger — P0 · H6 · Kostya

- Runs as a Convex cron (every 5 min in the §13 build; the §6 system flow pulls data every 15 min).
- Computes P, colors events, and creates a room when an event turns red.
- Agents are an event handler for the top of the queue; they don't run on every pair.

### F8. Analyst summary — P0 · H6 · Kostya

- For a red pair gathers orbits, uncertainty, fuel, mission windows and history of concessions (owner/purpose/country from KeepTrack).
- Produces a five-line summary plus two or three options. Maneuver options are fixed: raise, lower, wait.
- Doesn't represent either side.

### F9. Operator policy — P0 · H6 (policy files), H24–H30 (edit button) · Freya (content) + Adil (form)

A one-page form per operator (§7 screen 3).

- Fields: minimum fuel reserve, "don't move" mission windows, acceptable risk, mission priority per satellite; plus language and contact (§13).
- Editing a rule and re-running changes the proposal in front of the judge (demo second 70).

### F10. Operator agents A and B — P0 · H14 · Kostya

- One agent per company, each reads only its own policy.
- They propose, object and converge in 2–3 rounds of messages: who moves, when, by how much, and the resulting miss distance.
- They can't step outside their policy and don't execute.
- A new fact from a human ("can't move on Wednesday") is a new constraint; the agents recompute.

### F11. Explanation check — P0 (deterministic check) / P3 (second model) · Kostya

- Every number in a rationale comes from tools, not generation.
- Each explanation passes a deterministic check against the numbers before it reaches the screen.
- Optional: a second model (Grok text API) reads the same Executor explanation; if it disagrees, the discrepancy is highlighted to the human.

### F12. Dispatcher — P0 · H14 · Kostya

- Opens the room and calls the two owners plus anyone the proposed maneuver affects.
- Runs the conversation and translates (see F15).
- Writes every step to the log (F19).
- Doesn't vote or decide.

---

## 3. Conjunction room and humans

### F13. Conjunction room — P0 · H14 · Adil

Where the judge acts (§7 screen 2).

- Top: two orbits, conjunction point, countdown.
- Middle: Analyst's five-line summary; agents' negotiation transcript; human channel (voice and text), each line in the reader's language.
- Bottom: proposal card — who moves, when, delta-v, fuel, distance before → after.
- Status of both sides is visible.

### F14. Approve / Veto / Counter — P0 · H14 · Adil + Kostya

- Three buttons per side. A maneuver is scheduled only after **both** owners approve.
- After one approval the approving side sees "waiting for B"; after both, "both approved, scheduled, checked against the catalog."
- One "no" returns to the agents with a new constraint.
- Each side only sees its own buttons.

### F15. Bilingual channel — P1 (text + STT → Claude → TTS) / P3 (Grok Voice) · Kostya

Each person speaks and reads their own language (§8).

- Speech is recognized phrase by phrase, translated with the room's context (satellite names, terms like "imaging window"), numbers left untouched.
- The listener hears a voice in their language and sees text; the speaker sees their original in the transcript.
- A translated line that carries a constraint is passed to the agents.
- Both versions of every phrase are written to the log.
- Build order: C text chat with Claude translation (Sat morning) → A STT → Claude → Cartesia TTS (Sat afternoon) → B Grok Voice for the Dispatcher's voice and a spoken "approve" if time remains. If Grok Voice hasn't worked by H20, stay on A.

### F16. Third-party notice — P1 · Kostya

- If the agreed maneuver puts a third operator's satellite on the new path, that operator is notified before the maneuver, not after.
- Third parties are notified only if the maneuver affects them.

---

## 4. Execution and verification

### F17. Executor — P1 · H24 · Andrew (re-screening) + Kostya (file + diff)

- Runs only after two approvals.
- Writes the maneuver to the schedule (`maneuver.yaml` in the operator's repo); access is limited to that one schedule folder.
- Re-screens the moved satellite against the whole catalog, not only its partner. A new conjunction means refusal and a return to the agents.
- The human sees the diff ("what will change") before approving. Optional: Factory Droid writes the file, autonomy off, permission routed to our approve.

### F18. Verifier — P2 · H24 · Andrew

- After the maneuver time, compares new orbit data with the promised maneuver.
- Match → status "resolved" / "maneuver confirmed"; no match → a flag to both sides.
- Demo: run on historical TLEs of a real Starlink maneuver and show the jump.

---

## 5. Record

### F19. Audit log — P0 · H14 (writes), H24 (screen) · Kostya (writes) + Adil (screen)

The answer to "what if there's a dispute later" (§7 screen 4, §12 item 10).

- One immutable log, visible to both sides.
- Each line: time, who (agent or human), what they said or did, numbers before and after.
- Includes every agent message, every approval with identity and time, both languages of the conversation, and the verification result.

---

## 6. Screens

| Screen | Features | Priority |
|---|---|---|
| 1. Ops board — queue on the left, globe on the right, validation number in the corner | F3, F5, F6, F22 | P0 (queue), P2 (globe) |
| 2. Conjunction room | F8, F10, F13, F14, F15, F17 | P0 |
| 3. Policy | F9 | P0 |
| 4. Audit log | F19 | P0 |

Both laptops show the same screens from different sides: A has A's buttons, B has B's, lines in the owner's language.

---

## 7. Platform

### F20. Live sync on two laptops — P0 · H2 · Adil + Kostya

- One reactive database (Convex) holds all state: events, rooms, messages, approvals, log.
- Both laptops subscribe; updates appear simultaneously, no custom websockets.

### F21. Offline mode and fallbacks — P0 · H24–H30 · Andrew + Adil

- Wi-Fi down: everything runs from cache, backend local on one laptop, the second over LAN; tested by unplugging the network.
- Voice not audible in the hall: text chat with translation.
- Agent hangs: a "re-run" button.
- Last resort: the recorded Fetch.ai video doubles as the backup demo.

### F22. Globe — P2 · H24 · Adil

- globe.gl or CesiumJS, the constellation on the ops board.
- In the room: the two orbits and the TCA point; after approval the maneuver is shown and the distance number updates.

### F23. Fetch.ai agents — P2 · H14 · Kostya

- Each role is a separate uAgent with an address, registered on Agentverse.
- Operator A and Operator B negotiate via real messages using the Agent Chat Protocol.
- The main scenario is reachable from ASI:One chat.
- README lists agent names and addresses with the innovationlab and hackathon badges; submission via the ASI:One Submission Agent.
- If cut, agents stay as plain processes.

### F24. Operator identity — P3 · H24–H30 · Kostya

- Auth0 login, roles "owner of SAT-A / SAT-B"; an approval is signed by identity.
- Fallback: two URLs, `?role=A` and `?role=B`.

### F25. Agent memory — P3 · H24–H30 · Kostya

- Backboard memory between incidents: Operator A remembers it yielded last time.

### F26. Risk time series — P3 · H24–H30 · Andrew

- Tiger Data (Postgres + TimescaleDB): Pc and distance series per event.
- A "how risk grew" chart in the room; also input for the Verifier.

---

## 8. User stories → features

| User story (§6) | Features |
|---|---|
| See only the conjunctions that need a decision today | F2, F5, F6 |
| The other operator found and invited without me | F12, KeepTrack metadata in F8 |
| A ready proposal with before-and-after numbers | F8, F10, F11, F13 |
| Speak my own language and be understood immediately | F15 |
| Write my company's rules once, the agent bargains within them | F9, F10 |
| Know the other side actually did the maneuver | F18 |
| A log of every decision for disputes | F19, F24 |
| A third operator learns about the new path before the maneuver | F16, F17 |

---

## 9. Out of scope

From §12 "What we don't promise":

- True Pc with covariances (taken from SOCRATES / CDM).
- Real maneuver planning with delta-V optimization (three fixed options: raise, lower, wait).
- Replacing the operator; agents never act on a satellite.
- Solving operators' unwillingness to share data; that is policy, not software.
