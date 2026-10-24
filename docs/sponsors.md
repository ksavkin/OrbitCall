# Sponsors and prize tracks

Updated October 24, 2026 for master roadmap v1.1. The runtime stack is locked in [master-roadmap.md](master-roadmap.md), the team's source of truth. This file records sponsor roles, current code status, and evidence needed for judging.

Primary targets: Convex and SpaceXAI. All selected sponsors must contribute real runtime work. This is a hackathon strategy, not a plan to minimize provider count.

## 1. Locked runtime sponsors

| Sponsor | Locked role | Code status through baseline ec5ea34 | What to demonstrate |
|---|---|---|---|
| Convex | Application database, authorization, reactive queries, mutations, actions, scheduling, audit, search, artifact references | Phase 1 catalog/Analyst backend, OMM snapshot URL and frontend bridge in main. Private fleet/room/approval work remains | One decision updates four screens, current approvals are enforced, and real jobs/search work |
| SpaceXAI | Grok STT for EN/RU/ZH, Grok TTS for Russian, independent Grok rationale check. Actual Cursor use during development | Locked target. Audio implementation described in older branch notes is not present on baseline main | A real Grok audio call, checked transcript, Russian speech, and an accurate account of Cursor use |
| Anthropic | Claude Incident Analyst, private Operator Advocates, and translation | Checked Analyst runtime in main. Other roles remain to build | Checked explanations and a proposal revision driven by operator discussion |
| Google Gemini (MLH) | Coordination Host through the Gemini API and official `@google/genai` SDK in a Convex Node action | Locked target, not implemented on baseline main | A real host call, relevant clarification, and checked per-event summary in the shared room, with model/provider trace |
| Cartesia | English and Mandarin speech in the LiveKit translation path | Locked target, not implemented on baseline main | Natural translated speech in the core flow and a two-minute demo-first video |
| Auth0 | Pre-created dispatcher and observer identities, verified by Convex | Locked target, not implemented on baseline main | Different assigned fleets and denied unauthorized access/approval |
| Factory | TypeScript Droid SDK in a DigitalOcean Node worker, schedule preview and authorized artifact write | Locked target, not implemented on baseline main | A triggered SDK run, constrained workspace, visible diff, and the exact approved file result |
| Backboard | Isolated operator memory across incidents | Locked target, not implemented on baseline main | Store a source-linked preference, then recall it in a new incident without reusing approval |
| Tiger Data | PostgreSQL/TimescaleDB observation history and chart queries | Locked target, not implemented on baseline main | A real write/query and historical chart with source, time, and simulation labels |
| DigitalOcean | One CPU Droplet hosting the orbital API, translation worker, and Factory worker in containers | Locked host, deployment still required | Deployed services, persistent artifacts, health checks, logs, and measured numerical job work |

Baseline code presence does not establish live provider configuration. Record a successful provider/job result before claiming an integration works.

### Voice implementation history

The earlier sponsor review described code at `1c09d4f` on `kostya/voice-frontend`: Convex push-to-talk, Deepgram STT, Claude translation, Cartesia/Grok speech, and number-integrity checks. Commit `0bf8215` later planned Grok STT for Russian while keeping Deepgram for other languages and fallback. Those are branch notes and earlier choices. The current user-approved target is LiveKit with Grok STT for all three demo languages. Inspect and reuse tested pieces from that branch where they fit, then verify the target pipeline before marking it complete. Neither documentation commit establishes that the voice implementation is merged into baseline `main`.

## 2. Why the tools do not replace Convex

- Convex owns current incidents, proposals, approvals, room state, and audit records.
- Tiger Data receives a versioned copy of observations for analytics. It never authorizes a decision.
- Backboard returns advisory memory. Current policy and current authorization remain in Convex.
- Factory produces an artifact after authorization. It cannot choose a maneuver or change its numbers.
- DigitalOcean runs numerical and persistent-worker processes. It does not host a second application backend that bypasses Convex.
- Claude handles analysis, advocates, and translation. Gemini hosts shared coordination. Grok checks rationale and handles the selected audio tasks. Numerical risk evidence remains deterministic and sourced.

This supersedes the earlier recommendations to drop Backboard/Tiger Data and the Railway/Fly hosting alternatives. The locked voice path is LiveKit, Grok STT, Claude translation, Cartesia EN/ZH, and Grok RU TTS. Deepgram and Convex push-to-talk are not the selected target architecture.

Cartesia's current documentation lists Russian support. Russian is routed to Grok by project choice, not because Cartesia is categorically unable to speak it. [Cartesia model/language documentation](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest).

## 3. Current prize context

The live [Cal Hacks Hive prize page](https://hive.hackberkeley.org/prizes) and [Devpost event page](https://cal-hacks-13-0.devpost.com/) were checked October 24. Both currently list Convex at $5,000 and Best Use of Gemini API at MLH Swag Kits. Treat awards as organizer listings, not guaranteed winnings, and recheck final details before submission.

| Track | Organizer listing | Requirement or evidence to confirm |
|---|---|---|
| Convex | $5,000 cash | Real backend use and a clear explanation of reactive state/functions |
| SpaceXAI | Custom Cursor mechanical keyboard | Actual Cursor use and Grok Imagine or Voice API use under the Hive brief |
| Factory | $2,000, credits, swag | Droid SDK does visible work in the running product, explained in README |
| Cartesia | Meta glasses, still TBD | Core voice experience, working flow, setup/limitations, two-minute demo-first presentation |
| Anthropic | Award not announced in the viewed brief | Named community, real problem evidence, working flow, thoughtful Claude use. A real operator conversation is still missing |
| [MLH] Best Use of Gemini API | MLH Swag Kits | Real Gemini API use in the running Coordination Host, a checked clarification/summary, and visible contribution to the operator workflow |
| Auth0 | Wireless headphones | Actual Auth0 API integration |
| Backboard | Tile Essentials Pack | Actual persistent memory contribution |
| Tiger Data | Stream Deck Mini | Actual historical analytics contribution |
| DigitalOcean | Retro Wireless Mouse | Actual deployed use of DigitalOcean infrastructure |
| Vultr | M5Stack Official Tab5 | Alternative host, not selected. No Vultr runtime claim in this version |

There is no evidence in the public briefs that DigitalOcean or Vultr offers better winning odds. DigitalOcean was selected for the deployment plan. Do not add a second cloud solely to display another logo.

## 4. Submit-only tracks

These do not add runtime dependencies. Submit only if the current work meets the actual brief.

| Track | Relevant evidence |
|---|---|
| Overall / Most Technically Complex | Complete four-screen workflow, numerical checks, multilingual coordination, approval integrity |
| Best People-First | Humans communicate and approve the exact current plan |
| Best Planet-First | Sourced orbital-debris problem and a traceable avoidance workflow |
| Meta | Three people collaborate across languages using the shared room |
| Microsoft | Clear problem, measurable demo outcome, responsible boundaries, and end-to-end functionality |
| MLH Gen AI | Real Claude/Grok/Gemini contributions, with evidence of what each did |
| Hacker's Choice | A judge can use the product directly |
| Domain tracks | Register and use an eligible domain before claiming it |
| Commit Fellowship | Opt-in and supplemental requirements, only if the team wants that program |

The project scope is the hackathon demonstration. A production path can be explained without building billing, onboarding, or long-term commercial operations.

## 5. Not locked into this build

- ElevenLabs, Moss, Apify, Figma, Tiger alternatives, and other added runtime tools need a separate stack-change decision. Gemini is included under the v1.1 lock. Do not claim use from an SDK installed without a real contribution.
- Figma, Mana, Notability, and similar build-process tracks require actual, evidenced use. Do not reconstruct a false workflow after the fact.
- Payments, finance APIs, and unrelated hardware tracks have no current product role.
- Fetch.ai remains dropped. Its separate workflow does not replace the operator interface.
- Vultr, Railway, and Fly are hosting alternatives, not active deployment targets.

## 6. Submission evidence checklist

- Record one complete live demo path before adding more sponsor work.
- Capture one meaningful runtime result for every selected sponsor.
- Add README setup, features used, and known limitations for each integration.
- Keep API keys out of the repository and recordings.
- Mark real catalog data, simulated encounters, and historical replay separately.
- Keep Convex and SpaceXAI central in the explanation.
- Capture the Gemini Host's successful API call, model ID, checked output and room trace for Best Use of Gemini API. A planned integration is not a completed sponsor claim.
- Produce the Cartesia two-minute cut and the general event demo video.
- Confirm final brief/award changes and eligibility with the relevant sponsor before submission.
