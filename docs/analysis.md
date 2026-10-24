# OrbitCall — Feature analysis

What to add, change or cut in [functionality.md](functionality.md) after the competitor research. This is a proposal for the team to decide on; `functionality.md` is not changed yet.

Written Oct 24, 2026, ~00:40 PT (H≈4 of the hackathon).

## How this was made

- **Inputs:** three research notes (in Russian, kept locally, not in this repo):
  - `features_commercial.md` — ~27 commercial and government products compared by function (Satcat, Slingshot Beacon, OKAPI, LeoLabs, TraCSS, EU SST, ESA, NASA CARA, …).
  - `features_github.md` — open-source competitor repos (SpaceATC, PARLEY, Detour, Orbit Watch, Scutaris, orbitscreen, OrbitSense, …) and libraries.
  - `hackathons.md` — prior hackathon projects in this space across 54 events and what won.
- **Reviewers:** my own analysis plus three independent outside reviewers (models `hy3`, `glm-5.3-flash`, `deepseek-v4-flash`), each given the same raw task and inputs, not my draft. The **Votes** column shows who backed each item ("me" = my own analysis).
- **Function IDs** refer to [functionality.md](functionality.md). Costs are rough hours; **BE** = backend, **FE** = frontend.

## 0. Already in functionality.md

Commits 938d7a8 ("Updated functionality") and 78fef39 ("updated names of agents") landed while this analysis was being written. Against them:

| Item | Status |
|---|---|
| M1 approvals per revision | **Covered** by ROOM-11 and LOG-6: approvals are tracked per proposal version and do not carry over. Left for the UI: make the reset visible ("R2 created — approvals reset"). |
| M3 counter-proposal | **Partly covered** by AGT-11..AGT-13, ROOM-12 and POL-6: agents follow the voice and text discussion and separate hard constraints from preferences. Still open: whether Counter also has structured fields (open question 4). |
| M6 role names | **Done**, with different names: Risk Monitor, Incident Analyst, Operator Advocate, Coordination Host, Maneuver Scheduler, Maneuver Verifier. They no longer match the Detour / Scutaris pipeline or SpaceATC's "Maneuver Executor". |
| M7 verifier | **Partly covered** by VER-4 (awaiting sufficient data). The "promised vs done, not detection" framing and the detection method are still open. |
| M2 private policies | **Still open.** INBOX-5 and ROOM-12 refer to "policy visibility rules", which are not defined yet (open question 5). |

---

## 1. MUST — do in this hackathon

| # | Type | IDs | What | Why | Cost | Votes |
|---|---|---|---|---|---|---|
| M1 | CHANGE | ROOM-2, ROOM-7, ACC-2 | **Bind each approval to a proposal revision.** Any new constraint, counter, policy edit or recompute creates a new revision and resets both approvals. The card shows "R2 · A approved · waiting for B". | No product or repo found where both humans approve the exact same revision. This is the most defensible unique mechanism. | 3 h BE+FE | deepseek, glm, hy3, me |
| M2 | CHANGE | POL-2, ROOM-3 | **Policies are private in the API and the UI.** The other side sees only the outcome or a constraint category ("mission window", "fuel"), never the values. Answers open question 5. | Satcat's "Rules of the Road" are advisory and know nothing about fuel or mission windows; private policies only count if they are visibly separated. | 2–4 h BE+FE | deepseek, glm, hy3, me |
| M3 | ADD | new (ROOM-7, AGT-4) | **Structured counter-proposal.** Free text plus optional fields: who should move, not-before / not-after time, max Δv, max fuel. It becomes a constraint and forces a recompute. Answers open question 4. | No commercial product or open repo has a human counter-proposal inside a two-party negotiation. | 3 h BE+FE | deepseek, glm, hy3, me |
| M4 | CHANGE | LANG-2 | **Numbers in translation come from the proposal card, never from the model.** The translator gets placeholders and the numbers are inserted afterwards. | Orbit Watch's voice agent calls a tool for every number; otherwise a translation can turn 180 m into 18 m. | 0.5–1 h BE | hy3, deepseek, me |
| M5 | CHANGE | DATA-1, demo | **Demo on a real pair from this week** (SOCRATES or `cdm_public`), not a synthetic pair. | SpaceATC and PARLEY inject synthetic pairs; Orbit Watch won SpaceXAI with a real event of the week. | 2 h BE | all |
| M6 | CHANGE | §1 roles, all docs and UI labels | **Rename the agent roles** away from Scout / Analyst / Executor / Verifier. *Done in 78fef39 — see section 0.* | Detour (TreeHacks 2026) and Scutaris (HackMIT 2026, SpaceXAI winner) use the same Scout → Analyst → Planner → Safety → Ops Brief pipeline; SpaceATC has a "Maneuver Executor" node. A judge who saw them will recognise the diagram. | 1 h docs+UI | all |
| M7 | CHANGE | VER-1..VER-4 | **Maneuver Verifier = "promised vs done" in the shared log, not maneuver detection.** Detect the burn as a jump in semi-major axis / mean motion between consecutive element sets (above the object's own noise), and check sign and size against the promised Δv. Demo on a real historical maneuver (an ISS reboost or a Starlink burn). | LeoLabs (>2,000 maneuvers/day, ~1 orbit latency), Stargaze and Kratos detect maneuvers far faster than next-day TLEs. The gap is the shared promise-vs-fact record. | 2–3 h BE | all |
| M8 | CHANGE | SCR-2, SCR-4, SCR-9 | **Pc: use the official value from `cdm_public` where the pair matches; label our own Pc "indicative"; show the GP vs SupGP spread as a range.** No fixed σ. | SpaceATC hard-codes σ = 1 km, which reads as a toy. Satcat, LeoLabs and Space-Track compute real Pc from covariances; we don't have covariances. | 1–2 h BE | hy3, glm, me (deepseek: skip own Pc) |
| M9 | CUT / CHANGE | SCR-6 | **Drop the ML risk-trend model.** Use the naive rule "final risk = latest risk" plus the challenge winner's threshold rules; show an honest comparison table. | In the ESA Kelvins challenge only 12 of 97 teams beat the naive rule; a 2026 open LLM-agent attempt scored 2.4× worse. ESA's CREAM AutoCA already forecasts CDM evolution. | saves ~4 h; 1–2 h BE | all |
| M10 | CHANGE | SCR-3, SCR-8, pitch | **Remove "47 of 50 within 500 m" from the pitch.** If a validation number is shown, make it recall over the whole SOCRATES list for our objects on one snapshot, split into "different element set (SupGP)" vs "our miss". | orbitscreen (MIT, pushed Oct 23) claims 99.84% of 206,222 SOCRATES pairs; OrbitSense claims 85.8% recall. "47/50" looks weak next to them. | 1 h BE | all |

## 2. SHOULD — do if the core path works

| # | Type | IDs | What | Why | Cost | Votes |
|---|---|---|---|---|---|---|
| S1 | CHANGE | AGT-2, §19 | **Replace "raise / lower / wait" with computed candidates:** a small grid of Δv × burn time using the along-track approximation (shift ≈ 3·Δv·Δt), target Pc ≈ 3.2e-6 (NASA handbook post-maneuver goal). Agents bargain over these points. Fallback: 2–3 candidates, no chart. | Satcat, GMV, OKAPI, Neuraspace, ESA CORAM all optimise Δv; three fixed options is the plan's own admitted weakness. | 2–3 h BE + 1 h FE | glm (must), hy3, me; deepseek: 2 candidates only |
| S2 | ADD | new (POL) | **"Save as standing rule for this pair"** after both approve, plus SSC best-practice classes as the default policy when an operator has none. | OKAPI:Astrolabe (built with ESA) already offers "agree who maneuvers once, and the protocol applies automatically to every future event". This will be the first judge question. | 1–2 h BE+FE | glm (must), hy3, me; deepseek: skip |
| S3 | ADD | new (LOG) | **Export the FCC 26-47 §100.201(d) semi-annual report from the log** (count of conjunction events, including those that led to a maneuver or coordination with another operator). | Not found in any of ~27 products; Beacon only offers "logs". "The log is your regulator report" is a strong slide. | 1 h BE | glm (must), hy3, me; deepseek: skip |
| S4 | ADD | new (Q) | **Industry action label per queue row:** No action · Wait for update · Plan mitigation · Coordinate (NASA CARA categories, as Satcat uses). "Coordinate" is what opens a room. | Makes the queue speak the industry's language. | 0.5–1 h BE+FE | hy3, glm, me |
| S5 | ADD | new (Q) | **Dismissed rows with a visible reason:** co-orbiting (relative speed < 0.1 km/s), same launch, duplicate, below threshold. | Orbit Watch and satguard do this; it turns "1,000 pairs" into "3 decisions" on screen. | 0.5–1 h BE+FE | deepseek, me |
| S6 | ADD | new (Q) | **"Verify on CelesTrak" link** per row. | Orbit Watch uses it; shows the data is real. | 0.25 h FE | deepseek, me |

## 3. CUT or SKIP

| IDs | What | Why | Votes |
|---|---|---|---|
| AGT-6 | Second independent model checking the rationale | Doesn't sell as a market feature; SpaceATC already checks LLM text against numbers. Keep only the cheap deterministic check (AGT-5). | glm, deepseek |
| AGT-7 | Agent memory between incidents / reputation | Beacon already claims "responsiveness indicators". If cut, we lose the Backboard sponsor track. | glm, deepseek |
| DSP-3, DSP-6 | Building the third-operator notice | Narrow claim; keep it as wording only: "the affected third operator is invited into the room before signature". hy3 wanted it built (3 h). | glm, deepseek |
| DSP-2 (partial) | Calling by phone / email / push; Slack or webhook alerts | In-app only. Satcat and OKAPI do alerts better. | all |
| SYNC-3 (partial) | Serving the backend from one laptop to the other over the LAN | Fragile, no judge value. **Keep** the cached data snapshot: it is just files. | glm, deepseek, me |
| — | CDM KVN / OEM export, operator ephemeris upload (OEM/OCM), true Pc from covariances, Δv optimizer, Space-Track account linking, own sensors, launch COLA, re-entry, GEO, 24×7 support | Competitors own these; each is days of work. Answer verbally ("same parser, another endpoint"; "in production the facts come from LeoLabs or TraCSS"). | all |

**Disagreement kept open:** deepseek also proposed cutting the ASI:One entry point (EXT-3), the offline snapshot and real sign-in. I don't recommend cutting EXT-3: it is a Fetch.ai track requirement. Sign-in already has a fallback (`?role=A` / `?role=B`).

## 4. Do not pitch these as unique

They already exist elsewhere:

- Auto-opened room — Neuraspace.
- Operator contact directory — Satcat, TraCSS, OKAPI:Astrolabe, SDA.
- Audit log — OKAPI:Astrolabe, Beacon logs.
- Re-screening a maneuver against the catalog — everyone (TraCSS, LeoLabs, EU SST, Space-Track, Satcat).
- Risk-trend forecast — ESA CREAM AutoCA.
- Automatic maneuver recommendation — Satcat, OKAPI, Neuraspace, GMV, Vyoma.
- A "who moves" rule — Satcat Rules of the Road, OKAPI:Astrolabe.
- Checking LLM text against numbers — SpaceATC (`content_review.py`).
- Validation against SOCRATES — orbitscreen, OrbitSense, TCA-engine, Orbit Watch.

**What is unique (no product or repo found with the full chain):** each operator's agent negotiates within its company's **private** policy → a **human counter-proposal** becomes a constraint → **both humans approve the same revision** → each in **their own language** → **promised vs done** recorded in one shared log. In the pitch say "no commercial product", not "nobody": ESA's CREAM#3 AutoSTM pilots multi-agent negotiation, and PARLEY and SpaceATC showed parts of it at hackathons.

## 5. Open questions this answers

From [functionality.md §20](functionality.md#20-open-questions-for-the-specification):

- **Q3, Incident Analyst options:** replaced by computed candidates (S1), or 2–3 candidates as the fallback.
- **Q4, Counter:** structured counter (M3).
- **Q5, Policy visibility:** private; the other side sees only the outcome or a constraint category (M2).
- **Q6, Calling people:** in-app only for the hackathon.
- **Q7, Third-party notice:** wording only; not built (section 3).

Still open: Q1 screening horizon, Q2 cadence, Q8 event identity across sources, Q9 yellow events.

## 6. Interface

An interface brief for mockups is being prepared separately. All three reviewers agreed: the **Conjunction Room is the first demo screen**, the globe is a small inset, and the screen must show both sides, the private policy lock, the counter → new revision → approvals reset, and translation with the original one click away.
