# Frontend progress (Adil)

Source of truth: [master roadmap v1.1](../master-roadmap.md). It defines the four-screen demo, 2-4 operator rooms, EN/RU/ZH voice, sponsor roles, and DigitalOcean deployment. Claude runs analysis/advocates, Gemini runs the Coordination Host, and Grok runs independent checking and selected audio tasks. Existing implementation notes below are not completion claims.


Branch: `adil`. App: `web/`. Run with `cd web && npm run dev`, then open http://localhost:3000.

## Accepted target workflow (October 24, implementation pending)

The user selected [My Fleet + My Incidents + globe](../user-flow.md). Each enabled demo dispatcher has four assigned spacecraft. The main demo uses three dispatcher laptops based in the US, Russia and China, plus a read-only large display. Linked-event rooms support 2-4 operators. Run Scan checks the full assigned fleet against all other usable catalog objects for 72 hours. Selecting a satellite filters incidents, not scan scope. Country/flag/language do not grant object access.

Priority: severity first, then earliest closest approach; missing/stale data is a separate visible review section. Explain TCA as "Time until closest approach". Show up to four computed candidates. Selecting an existing card changes the shared selection without countering or approving. Each required side then presses Approve. Confirmed debris has one real active-object approver, never an auto-approved debris side.

The historical implementation notes below describe the simulator. Its Pc/time sorting, fixed four options, auto-approved debris, private traces, affected-party notification and fast verification are not the accepted backend behavior. Country-based demo assignments and replay must remain visibly simulated.

Agent traces must identify the actual provider/model for each call, including the Gemini Host. Show provider results only after backend integration. A local simulator animation does not establish live sponsor use.

## Merged backend and mode boundary

Phase 1 Convex catalog/snapshot/Analyst integration is now included alongside the latest simulator. Dev on keeps TLE plus synthetic scenarios. Dev off waits for backend OMM and never loads `/api/catalog` or substitutes a synthetic event. Phase 1 returns `ommUrl: null`; the real OMM loader and renderer are still pending. The full assigned-fleet flow below remains a target, not completed backend functionality. See [integration status](../integration-status.md).

## Where things stand

The Orbit screen is done and the Conjunctions screen is built against the backend contract with a dev simulator. Rooms, Policy, Audit log and Inbox are not started.

## Done

| Commit | What it added |
|---|---|
| `792e449` | Next.js app, live CelesTrak catalog pipeline with a 2 h cache and an offline snapshot |
| `ff34adf` | Orbit view: globe with 5 views, live SGP4 satellites in a worker, navbar, footer, sounds |
| `5489951` | Selection and follow polish, PBR hero model with reflections, Starlink model, owner flags |
| `ee190a7` | Live weather (clouds, wind, currents, storms, tornadoes, aurora, Kp), congestion layers, country filter and coloring, night and terrain fixes |
| `c72790a` | Congestion as a thermal map, ground track stays on while following |
| `d004fda` | Thermal map without clipped plateaus |
| `9ef2617`, `b1766c2` | Dev switch, Conjunctions screen, agents window, scenario simulator, these docs |
| `cf2d9c8` | Cinematic camera that follows the agents' work, call feed (newest open, older collapse), real Claude and Grok marks, conjunction icon, summary card first |
| `05706dd` | Event parties on the agent graph with dispatcher flags (2+ parties), affected third operator notice |
| `efaa6c6` | Night lights: Black Marble snow and ice no longer glow as tile-shaped rectangles |
| next commit | Demo flow: Run scan, ranked results with priority and confidence, red urgency glow, banner and alarm, decision dock (summary, 4 options with one recommended, text or voice answer, reject), waiting on the other side, their reply with translation |

## Conjunctions screen (this round)

- **Dev switch** in the navbar (`D`). Off: ops panels show "backend not connected". On: the simulator in `web/src/lib/ops/engine.ts` fills the same store the backend adapter will fill.
- **Queue** (left): red first, then Pc divided by hours to TCA. Each row has countdown, miss, Pc with trend, status, and a light sweep while agents work. The open row shows the numbers, a Pc chart on a log axis with the 1e-4 line, the five-line summary, the proposal card with approvals per side, approve / veto / counter, and Preview TCA.
- **Globe**: both orbits of the focused event cross at the TCA point. The synthetic object is a real two-body orbit built to pass the real satellite at the stated miss distance (`web/src/lib/ops/encounter.ts`, checked by `measureMiss`). Preview TCA jumps the clock 70 s before TCA and frames the crossing. The Risk Monitor's screening pass shows as a sweep around the LEO shell that lights up the satellites it passes.
- **Agents window** (right, expandable to full screen): agent graph with live call and answer pulses, "needs you" edges to the operators, check and failure badges. The Now card streams the thinking summary with tokens, latency and cost. Trace shows every step as a waterfall row with request, response, HTTP line and model. Logs show every line with filters.
- **Scenarios** (bottom bar, dev only): six user stories from the docs. Veto then re-plan (the demo scene from plan-v1 §7), both approve, scheduler refuses, second opinion disagrees, debris with one side moving, no agreement. Pause, 1× / 2× / 4×, autopilot for the operator answers, reset.
- **Backend target contract**: `docs/specification.md`. `web/src/lib/ops/types.ts` is the current simulator view model, not an identical shared schema. Add an adapter for IDs, units, nullability, lifecycle, candidate revisions and selection generation.

## Checked in the browser (2026-10-24)

- Dev on, Conjunctions tab, demo scenario from start to "Maneuver confirmed", at 1× and 4×.
- Proposal v1, B's veto, re-plan to v2, both approvals, scheduling, verification.
- Preview TCA: objects converge at the TCA point on both orbits, range shrinks to under 100 km in view.
- Expanded agents view, trace grouping of screening passes, log stream.
- Dev off: queue and agents empty states.

## Demo flow (dev)

Run scan (queue, top) screens the catalog with the sweep and the camera pulled wide, then opens the ranked results. Red finds turn the screen edges red, show the urgency banner and sound the alarm (muted with the sound toggle). Pick a case and the agents run on it with the cinematic camera. When the proposal is ready, the decision dock opens in the middle: summary, four options with the agents' pick marked Recommended, a free answer by text or voice (Web Speech API), Reject and Approve. Then it shows "waiting for" the other side with their flag, their reply in the original language with the translation, and "Both approved". The person at the screen is Operator A; Operator B answers on autopilot.

## Not checked yet

- Scenarios other than "Veto, then re-plan" were not run end to end in the browser.
- Manual approve / veto / counter with autopilot off.
- Layout below 1280px width.
- Sounds for the new events (alert, chime) were not listened to.

## Known gaps and placeholders

- Grok model ids and prices are placeholders (`web/src/lib/ops/roster.ts`). Grok cost shows `—`.
- SOCRATES, SupGP and KeepTrack request URLs in the traces are display placeholders until the backend spec fixes them.
- The SOCRATES validation badge (47/50) comes from the simulator. In prod it comes from `validation.latest` with full declared eligible scope, not a hard-coded top-50 badge.
- Synthetic B objects are drawn as glow points, not 3D models.

## Next

1. Conjunction room screen: transcript with translation, proposal revisions, approve / veto / counter per side, maneuver diff.
2. Backend adapter and common command interface for simulation/Convex. Use `fleet.listMine`, `scans.startMine`, `scans.getMine`, `events.myQueue`, `events.orbits` and the room APIs in `docs/specification.md`. Decouple geometry from `engine.encounters`, buttons from `engine.decide`, and backend availability from the Dev switch.
3. Policy form, Audit log, Inbox.
