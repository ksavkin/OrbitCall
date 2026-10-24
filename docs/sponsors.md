# Sponsors and prize tracks

Prize data comes from the [Hive prize page](https://hive.hackberkeley.org/prizes) (updated Oct 24, 2026, 10:46 AM). The status column reflects the code at `1c09d4f` (`kostya/voice-frontend`), not the plan. This file replaces the status in [plan section 11](plan-v1.md#11-sponsor-plan-what-we-take-what-we-dont-and-what-it-costs-in-time). The plan's rules still apply: a sponsor needs its own role in the demo, and the H24 cut rule holds.

Status values: **in code**, **planned** (in the docs, no code), **if time** (optional, section 4), **submit only** (no code needed), **not a fit**, **dropped**.

## 1. In code today

| Sponsor | Where | What the track requires | How we meet it | Gap | Prize |
|---|---|---|---|---|---|
| Convex | All backend: `convex/schema.ts`, reactive queries, mutations, actions, `crons.ts` (recolor every 5 min), `ctx.scheduler` (analyst start, watchdog, voice pipeline), `ctx.storage` (voice audio), `httpAction` (`/voice/tts` streaming route) | Convex as the real backend ("database, functions, workflow, sync, search, file storage") | Strong. It is the single source of truth, and both laptops subscribe to it | Not used yet: auth (`getUserIdentity`), text search, components such as Workflow. A "How we use Convex" README section | $5,000 cash |
| Anthropic | Incident Analyst (`convex/lib/claude.ts`, `ANTHROPIC_MODEL`, `claude-sonnet-5-5` on the shared deployment); voice translation (`convex/voice/process.ts`, `claude-opus-5-5` by default) | 1. A named community. 2. A real problem you lived or heard from someone who has. 3. It works: one thing done well. 4. Thoughtful use of Claude, and you know where it could go wrong | 1, 3 and 4 are strong: small operators with 5–50 satellites and no 24/7 shift; analyst output is checked against the numbers; `numberGuard` (48 test cases) checks translations; low-confidence text goes to the author as a confirm chip | **Point 2 has no evidence.** The docs cite articles, not a conversation. Get one real operator or dispatcher conversation (a call, a Discord thread, an email) and quote it in the pitch | Not announced |
| Cartesia | TTS for every listener language except Russian (`requestCartesia`, `sonic-3.6`); Grok is the fallback | Voice is core; a working demo; a **2-minute demo-first video**; a README with setup, **Cartesia features used** and **known limitations**; no keys in the repo. Judged on problem, Cartesia use, execution, and impact and responsibility (25% each) | Voice is core: the room's translated call. Keys live in the Convex env, and `.gitignore` covers `.env*` | No README section; the README voice row still says LiveKit and Grok STT. No 2-minute video. Russian goes to Grok (per the code comment, the Cartesia team said Russian is not supported), so the pitch must say exactly which half Cartesia speaks | Meta glasses (TBD) |
| SpaceXAI (xAI Grok) | Grok TTS for Russian listeners (`requestGrok`, `api.x.ai/v1/tts`); Cartesia is the fallback | A space project: "real space data goes in and a legendary project comes out". **Must be built with Cursor** ("the more you use Cursor, the more likely you win") **and** use the Grok Imagine or Voice API. Bonus: Grok Bot for planning | **The theme is a direct fit:** we run on the real public catalog (CelesTrak GP, SOCRATES) and solve a real orbital-safety problem. Few teams will match the theme this closely. **The two gates are open:** nothing in the repo shows Cursor use (commits are co-authored by Claude Code), and whether `/v1/tts` counts as the "Voice API" is unconfirmed | Worth closing both gates. Teammates write real code in Cursor and say so in Devpost. Confirm Grok TTS at the SpaceXAI table. Grok STT (the original plan, C3) would make the Voice API use unambiguous | Custom Cursor keyboard |

Deepgram (`nova-3`, batch and streaming STT) is **not a sponsor**, so it wins nothing. See candidate C3.

## 2. Planned, no code

| Sponsor | Planned role | Track requirement | Status | Hours (estimate) | Prize | Verdict |
|---|---|---|---|---|---|---|
| Auth0 (MLH) | Login for the pre-created test users (ACC-1); Convex verifies identity on every read, write and subscription | Use any Auth0 API | Not started: no `auth0`, `ConvexProviderWithAuth0` or `getUserIdentity` in the code | ~1 | Wireless headphones | **Do it.** The privacy story (POL-2, M2) needs server-side identity anyway, and it also adds Convex auth to the Convex story |
| Factory Droid SDK | Maneuver Scheduler: Droid prepares `operators/<operator>/schedule.json`, the room shows the diff, and Droid writes it after both approvals (EXE-1) | Droid does real work in the running product; the README explains where and how. Scores well: a trigger you designed, control over what Droid can touch, visible plans, steps and diffs. Scores poorly: a chatbot wrapper | Not started | 3+ | $2,000 + credits | Strong fit for their criteria (trigger = two approvals, write access to one folder, visible diff). Check whether the SDK can run from a Convex Node action; otherwise it needs a separate host process, which does not exist yet |
| Backboard (MLH) | Agent memory between incidents | Use Backboard | Not started | ~1 | Tile pack | **Drop.** Convex already stores history, and an outside memory store is one more place where private policy values could leak |
| Tiger Data (MLH) | Pc time series and "how risk grew" chart | Use Tiger Data | Not started | 1–2 | Stream Deck Mini | **Drop.** A second database undercuts the Convex "single source of truth" story |
| Grok text API (AGT-6) | Second model checks each rationale | — | Not started | ~1 | None: Grok text does not count toward SpaceXAI | Use Gemini instead (C2) |

## 3. Submit only (no code, needs a good Devpost write-up)

| Track | Why we fit | What the write-up must show |
|---|---|---|
| Cal Hacks: First/Second/Third Overall | — | The two-laptop demo working end to end |
| Cal Hacks: Most Technically Complex | SGP4 screening, checked agents, protected translation, reactive two-party approval | The checks, not just the features |
| Cal Hacks: Best Planet-First | Orbital debris and collision avoidance are about keeping orbit usable; one collision creates thousands of fragments | The sustainability angle in one sentence |
| Cal Hacks: Best People-First | "Nothing moves without a human"; two people approve the same revision | Human approval as the design center |
| Cal Hacks: Hacker's Choice | — | A demo people want to try |
| Meta: Bringing People Closer Together with AI | Two operators in different countries, languages and time zones talk and agree in one room; AI translates and prepares options | Human connection first, AI as the means. Prize: invitation to Round 2 at Menlo Park (eligibility check) + swag |
| Microsoft: Built for the Real World (grand prize) and Customer Impact Award | Production-minded agent in a high-impact domain | Customer understanding, measurable usefulness (validation recall against SOCRATES), path to production ("who pays", plan section 3), responsible design (checks, human approval), end-to-end function. Prize: a Surface laptop per member |
| MLH Best Use of Gen AI | Claude is core | Name the API |
| MLH Commit Fellowship | A real problem and a working prototype | Opt in and fill in the supplemental form |
| MLH Best .Tech Domain | Register `orbitcall.tech` | ~10 minutes |
| MLH GoDaddy Registry domain | Register a second domain through GoDaddy Registry | ~10 minutes |

If Devpost caps how many tracks a team can opt into, rank by fit and prize.

## 4. Add if we have time

Optional. Start these only after the H24 check of accepted scope passes (plan section 13). Each one has its own role in the product, and none is committed.

| # | Sponsor | Role | Requirement | Hours (estimate) | Prize | Note |
|---|---|---|---|---|---|---|
| C1 | Cartesia voice cloning (upgrade, not a new sponsor) | The listener hears the other operator's own voice in their language. "Keep-your-voice … speaking another language" is on Cartesia's own idea list | Same Cartesia track | 1–2 | Strengthens the Cartesia and Meta entries | Works only for Cartesia languages, which is the English side in an RU↔EN demo. Needs explicit consent before cloning, which also scores on their "impact and responsibility" criterion. Check clone quality on a test clip first |
| C2 | Gemini (MLH) | The independent second model for AGT-6, replacing Grok text | Use the Gemini API | ~1 | MLH swag kit | Same work as the planned Grok check, but this one counts toward a track |
| C3 | Grok STT **or** ElevenLabs Scribe (MLH) | Replaces Deepgram, which wins nothing. Add one more engine next to `deepgram` and `local`; keep Deepgram as the fallback | SpaceXAI Voice API / any ElevenLabs use | 1–2 | Cursor keyboard / wireless earbuds | Prefer Grok STT: it strengthens SpaceXAI, our best theme fit. Use ElevenLabs only if the SpaceXAI gates can't be closed. Both list Russian, but check it on a test clip. Don't break the working voice path: ship it behind the engine flag |
| C4 | DigitalOcean or Vultr (MLH) | Host the Python orbital service, or the local Whisper STT (`LOCAL_STT_URL`) on a Vultr GPU, so audio stays on our own infrastructure | Use their cloud | ~0 beyond the deploy | Retro mouse / M5Stack Tab5 | Only if that service is actually deployed. It replaces Railway/Fly in the plan |
| C5 | Convex extras | Text search over the shared log and messages; the Workflow component for approve → re-screen → schedule → verify | Same Convex track | 1–3 | Strengthens the $5,000 entry | Workflow fits the durable approval chain; search fits the inbox and history |
| C6 | Figma | Only if the UI was actually designed in Figma | Every member Edu-verified; Figma files public; Figma Slides deck (required); a stage log per stage (ideation, prototyping, handoff, code generation); a 3-minute video | 2–3 for the write-up | $500–$2,000 per category + recruiter session | Ask Adil. Writing a stage log after the fact for a workflow that didn't use Figma is not worth it |
| C7 | Moss | Low-latency retrieval for the voice room (incident facts, satellite names, glossary for translation) | Voice AI, personal agent or social post | 2–3 | AirPods Max/Pro | Real-time semantic search runtime for voice agents (JS and Python SDKs). Only with real SDK use; not on the critical path |
| C8 | Apify | Run the SOCRATES and CelesTrak ingest (`scripts/fetch_socrates.py`) as an Apify Actor that Convex calls on a schedule | Meaningful use; a separate Best Actor award | 2–3 | $400–$2,000; Best Actor $400 | Weak: judges may see it as wrapping a CSV download. Low priority |

## 5. Not a fit

- **Atlassian:** the project must be a Forge app for Jira or Confluence. Not our product.
- **Spacetime:** same role as Convex; we use one.
- **Creao AI:** the brief is not public (HTTP 401). Ask the sponsor before deciding.
- **Mana ($5,000), Notability:** require real use during the build, with public links or notes. Judges penalize use added after the fact.
- **Hyphenate, Visa, Coinbase x402, Capital One Nessie, CRS, Solana:** finance and payments. We have none.
- **Bright Data:** the product must stop working without live scraped web data. Our data comes from direct public APIs.
- **Presage, Snowflake, MongoDB Atlas, Bitdeer, Elastic, AfterQuery, Annapurna Labs, Cal Hacks Hardware/Beginner/Solo:** no role, or terms not announced.
- **Fetch.ai: dropped Oct 24, 2026.** Its prize requires the whole workflow inside ASI:One chat ([functionality.md §17](functionality.md#17-agent-runtime)).

## 6. Next actions

1. **Anthropic:** one real conversation with an operator or dispatcher, quoted in the pitch.
2. **Cartesia:** a README section (setup, Cartesia features used, known limitations including "Russian is spoken by Grok") and the 2-minute demo-first video. Update the README voice row to the real stack: push-to-talk over Convex, Deepgram STT, Claude translation, Cartesia/Grok TTS.
3. **SpaceXAI:** the space theme fits better than any other track, so close the gates. Teammates build in Cursor from now on and describe that use in Devpost. Confirm at the SpaceXAI table that Grok TTS counts as the Voice API. If it doesn't, Grok STT (C3) moves up.
4. **Auth0:** about an hour. Needed for privacy anyway.
5. **Domains, Meta, Microsoft, Commit Fellowship, Gen AI, Planet-First:** tick them in Devpost with a sentence each.
