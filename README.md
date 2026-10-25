<div align="center">

# OrbitCall

**Helping dispatchers avoid satellite collisions**<br>
**through multilingual communication and AI-assisted decisions.**

<p>
  <a href="https://orbitcall.vercel.app/"><img src="docs/assets/readme/links/live-demo.png" height="38" alt="Open the live OrbitCall demo"></a>
  <a href="https://devpost.com/software/orbitcall"><img src="docs/assets/readme/links/devpost.png" height="38" alt="Read the Cal Hacks submission on Devpost"></a>
  <a href="https://www.youtube.com/watch?v=M4Y5Gk3190E"><img src="docs/assets/readme/links/video.png" height="38" alt="Watch the OrbitCall demo video"></a>
</p>

**Cal Hacks 13.0** · October 23-25, 2026 · Hackathon submission

[![Watch OrbitCall: a shared workspace for satellite dispatchers](docs/assets/readme/demo-video.jpg)](https://www.youtube.com/watch?v=M4Y5Gk3190E)

[Overview](#why-we-built-it) · [Workflow](#the-operator-workflow) · [Architecture](#architecture) · [Tech stack](#technology-and-sponsor-contributions) · [Data](#real-data-and-reproducible-calculations) · [Run locally](#run-locally) · [Vision](#vision)

</div>

OrbitCall brings fleet monitoring, orbital calculations, AI agents, and translated calls into a shared workspace for satellite operators. Each dispatcher works with an assigned fleet. Operators compare maneuver options, discuss the same evidence, and explicitly approve the plan while keeping company policies private.

### Built with

<p align="center">
  <a href="https://www.convex.dev/"><img src="docs/assets/readme/logos/convex.png" width="44" height="44" alt="Convex" title="Convex: shared state and backend jobs"></a>&nbsp;
  <a href="https://www.anthropic.com/"><img src="docs/assets/readme/logos/claude.png" width="44" height="44" alt="Claude" title="Claude: analysis, policies, and translation"></a>&nbsp;
  <a href="https://ai.google.dev/"><img src="docs/assets/readme/logos/gemini.png" width="44" height="44" alt="Gemini" title="Gemini: coordination host"></a>&nbsp;
  <a href="https://x.ai/"><img src="docs/assets/readme/logos/grok.png" width="44" height="44" alt="Grok" title="Grok: reasoning checks and speech"></a>&nbsp;
  <a href="https://livekit.io/"><img src="docs/assets/readme/logos/livekit.png" width="44" height="44" alt="LiveKit" title="LiveKit: shared audio rooms"></a>&nbsp;
  <a href="https://cartesia.ai/"><img src="docs/assets/readme/logos/cartesia.png" width="44" height="44" alt="Cartesia" title="Cartesia: English and Mandarin speech"></a>
</p>
<p align="center">
  <a href="https://www.digitalocean.com/"><img src="docs/assets/readme/logos/digitalocean.png" width="44" height="44" alt="DigitalOcean" title="DigitalOcean: orbital and voice services"></a>&nbsp;
  <a href="https://vercel.com/"><img src="docs/assets/readme/logos/vercel.png" width="44" height="44" alt="Vercel" title="Vercel: frontend hosting"></a>&nbsp;
  <a href="https://auth0.com/"><img src="docs/assets/readme/logos/auth0.png" width="44" height="44" alt="Auth0" title="Auth0: operator identity"></a>&nbsp;
  <a href="https://backboard.io/"><img src="docs/assets/readme/logos/backboard.png" width="44" height="44" alt="Backboard" title="Backboard: company memory"></a>&nbsp;
  <a href="https://www.tigerdata.com/"><img src="docs/assets/readme/logos/tigerdata.png" width="44" height="44" alt="Tiger Data" title="Tiger Data: observation history"></a>&nbsp;
  <a href="https://factory.com/"><img src="docs/assets/readme/logos/factory.png" width="44" height="44" alt="Factory" title="Factory: schedule artifacts"></a>
</p>

## Why we built it

When two satellites approach each other, an alert is only the start. Operators still need to understand the evidence, decide who should move, and check that the maneuver will not create another close approach.

ESA's [2025 Space Environment Report](https://www.esa.int/Space_Safety/Space_Debris/ESA_Space_Environment_Report_2025) describes growing collision-avoidance activity as traffic and debris increase. ISRO's [report for 2025, published in 2026](https://www.isro.gov.in/Indian_Space_Situational_Awareness_Report_2025.html), records **82 LEO maneuver plans revised to avoid post-maneuver close approaches**.

Our focus is the coordination between those steps: a place where operators can understand the same incident, discuss options in their own language, and see exactly what they are agreeing to.

## The operator workflow

| Step | What the operator does | What OrbitCall contributes |
|---|---|---|
| **1. Detect** | Opens the assigned fleet and starts a scan | A globe with satellite positions, a pinned catalog, and a 72-hour screening window |
| **2. Compare** | Reviews the encounter and available options | Calculated maneuver candidates, checked explanations, and private policy evaluation |
| **3. Coordinate** | Talks or writes to the other operators | One shared room, English/Russian/Mandarin translation, clarifications, and summaries |
| **4. Approve** | Selects a plan and explicitly approves its current revision | Separate selection and approval records, a catalog re-screen, and an authorized schedule artifact |
| **5. Review** | Returns to the incident record and later observations | Source history, the agreed plan, and evidence that is consistent, conflicting, or insufficient |

Three dispatchers share one case across English, Russian, and Mandarin, while a read-only globe shows the activity on a large display. Each dispatcher has four assigned spacecraft. Rooms group linked pair incidents and their responsible operators. Each incident keeps its own proposals and approvals.

The main screens are **Orbit**, **Decision Center**, **Policy**, and **Inbox**. Starting a workflow creates the shared case, joins the responsible operators, and sends their notifications. The two sides take decision turns. A maneuver affecting several incidents uses one trajectory plan, with current approvals required for every affected pair.

Selecting a card does not approve it. Speech does not approve it. A changed proposal requires fresh approval. An active-spacecraft pair needs its required operators, while confirmed debris has a separate one-operator process. The [user flow](docs/user-flow.md) and [API specification](docs/specification.md) define these rules.

## Architecture

[![OrbitCall system architecture: Auth0 and Vercel clients connect to Convex, LiveKit connects to a DigitalOcean translation worker, and backend services provide agents, memory, orbital calculations, and history.](docs/assets/readme/architecture.png)](docs/assets/readme/architecture.svg)

[Open the full-size diagram](docs/assets/readme/architecture.png) · [Editable SVG](docs/assets/readme/architecture.svg)

**Convex owns the application state.** Browsers read authorized queries and send commands through mutations. Actions call the orbital service and AI providers, then publish checked results. The shared state updates the operator screens and observer display.

**DigitalOcean hosts the long-running services.** The Python orbital API runs calculation jobs. A separate Python worker joins LiveKit rooms, transcribes speech, translates checked text, and publishes audio. Docker Compose and Caddy define the deployment. The deployed orbital API and voice worker have passed recorded infrastructure checks. A separate Node.js worker uses Factory to prepare reviewable schedule files. [Deployment evidence](deploy/demo-status.md)

**The browser draws the orbits.** Three.js renders the globe, and satellite.js propagates the pinned orbital elements in a Web Worker. The numerical service handles authoritative screening and maneuver calculations. Browser animation never creates an approval or a screening result.

### Three agent providers, distinct roles

| Provider | Role | Input and output |
|---|---|---|
| <a href="https://www.anthropic.com/"><img src="docs/assets/readme/logos/claude.png" width="28" height="28" alt="Claude"></a> **Claude** | Incident Analyst and Operator Advocates | Explains checked incident facts and evaluates candidates against each company's private policy. Shared results contain feasibility outcomes and categories rather than private limits |
| <a href="https://ai.google.dev/"><img src="docs/assets/readme/logos/gemini.png" width="28" height="28" alt="Gemini"></a> **Gemini** | Coordination Host | Uses shared room context to ask clarifying questions and produce summaries tied to current events, messages, and candidate revisions |
| <a href="https://x.ai/"><img src="docs/assets/readme/logos/grok.png" width="28" height="28" alt="Grok"></a> **Grok** | Independent rationale check | Reviews shared explanations and reports agreement or disagreement. It supplements deterministic checks and has no approval authority |

Claude also translates text. Grok also supplies speech recognition and Russian speech. Provider calls record their model, input version, result, and available usage information. Stale or invalid output is rejected before publication.

### Live translation

```mermaid
flowchart LR
    A[Operator microphone] --> L[LiveKit room]
    L --> S[Grok speech recognition]
    S --> P[Protect numbers and identifiers]
    P --> T[Claude translation]
    T --> C[Restore and validate values]
    C --> EN[Cartesia: English]
    C --> ZH[Cartesia: Mandarin]
    C --> RU[Grok: Russian]
    EN --> O[Listener audio in LiveKit]
    ZH --> O
    RU --> O
    C --> DB[Original and checked text in Convex]
```

The translation worker handles this pipeline on DigitalOcean. It listens only to human microphone tracks, so translated audio cannot feed back into recognition. It protects numbers, signs, units, times, and satellite identifiers before translation and checks them afterward. If translation fails validation, the original remains visible. Persistent text is available alongside the call.

[Voice worker, setup, measurements, and known limits](services/voice/README.md)

## Technology and sponsor contributions

### Application and infrastructure

| Technology | Where we use it |
|---|---|
| <a href="https://nextjs.org/"><img src="docs/assets/readme/logos/nextjs.png" width="28" height="28" alt="Next.js">&nbsp;<strong>Next.js</strong></a><br><a href="https://react.dev/"><img src="docs/assets/readme/logos/react.png" width="28" height="28" alt="React">&nbsp;<strong>React</strong></a><br><a href="https://www.typescriptlang.org/"><img src="docs/assets/readme/logos/typescript.png" width="28" height="28" alt="TypeScript">&nbsp;<strong>TypeScript</strong></a> | App Router frontend, operator interface, typed backend contracts |
| <a href="https://threejs.org/"><img src="docs/assets/readme/logos/threejs.png" width="28" height="28" alt="Three.js">&nbsp;<strong>Three.js</strong></a><br>[**satellite.js**](https://github.com/shashwatak/satellite-js) | Custom globe, satellite rendering, orbit paths, and browser propagation |
| <a href="https://tailwindcss.com/"><img src="docs/assets/readme/logos/tailwind.png" width="28" height="28" alt="Tailwind CSS">&nbsp;<strong>Tailwind&nbsp;CSS</strong></a><br>[**Motion**](https://motion.dev/)<br><a href="https://zustand.docs.pmnd.rs/"><img src="docs/assets/readme/logos/zustand.png" width="28" height="28" alt="Zustand">&nbsp;<strong>Zustand</strong></a><br>[**Lucide**](https://lucide.dev/) | Styling, animation, local interface state, and controls |
| <a href="https://www.convex.dev/"><img src="docs/assets/readme/logos/convex.png" width="28" height="28" alt="Convex">&nbsp;<strong>Convex</strong></a> | Reactive database, server functions, job scheduling, shared messages, agent-run records, and authorization checks |
| <a href="https://auth0.com/"><img src="docs/assets/readme/logos/auth0.png" width="28" height="28" alt="Auth0">&nbsp;<strong>Auth0</strong></a> | Operator identity and the sign-in bridge to Convex. Fleet assignments determine which objects a user can act for |
| <a href="https://www.python.org/"><img src="docs/assets/readme/logos/python.png" width="28" height="28" alt="Python">&nbsp;<strong>Python</strong></a><br><a href="https://fastapi.tiangolo.com/"><img src="docs/assets/readme/logos/fastapi.png" width="28" height="28" alt="FastAPI">&nbsp;<strong>FastAPI</strong></a><br><a href="https://numpy.org/"><img src="docs/assets/readme/logos/numpy.png" width="28" height="28" alt="NumPy">&nbsp;<strong>NumPy</strong></a><br>[**SGP4**](https://celestrak.org/publications/AIAA/2006-6753/) | Fleet screening, candidate geometry, re-screening, simulation, and verification calculations |
| <a href="https://vercel.com/"><img src="docs/assets/readme/logos/vercel.png" width="28" height="28" alt="Vercel">&nbsp;<strong>Vercel</strong></a> | Next.js frontend and versioned orbital files served to the browser |
| <a href="https://www.digitalocean.com/"><img src="docs/assets/readme/logos/digitalocean.png" width="28" height="28" alt="DigitalOcean">&nbsp;<strong>DigitalOcean</strong></a><br><a href="https://www.docker.com/"><img src="docs/assets/readme/logos/docker.png" width="28" height="28" alt="Docker">&nbsp;<strong>Docker</strong></a><br><a href="https://caddyserver.com/"><img src="docs/assets/readme/logos/caddy.png" width="28" height="28" alt="Caddy">&nbsp;<strong>Caddy</strong></a> | Deployment configuration for the orbital API, voice worker, persistent data, and HTTPS routing |

### AI, voice, memory, and history

| Technology | Contribution | How it fits |
|---|---|---|
| <a href="https://www.anthropic.com/"><img src="docs/assets/readme/logos/claude.png" width="28" height="28" alt="Claude">&nbsp;<strong>Anthropic&nbsp;Claude</strong></a> | Incident analysis, private-policy evaluation, and checked translation | Explains calculated evidence, checks company policies, and translates messages while preserving numerical values |
| <a href="https://ai.google.dev/"><img src="docs/assets/readme/logos/gemini.png" width="28" height="28" alt="Gemini">&nbsp;<strong>Google&nbsp;Gemini</strong></a> | Coordination clarifications and per-event summaries | Uses the official Google GenAI SDK in a Convex Node action with validated structured output |
| <a href="https://x.ai/"><img src="docs/assets/readme/logos/grok.png" width="28" height="28" alt="Grok">&nbsp;<strong>xAI&nbsp;Grok</strong></a> | Rationale checking, streaming speech recognition, and Russian TTS | Text and audio integrations have separate roles and configuration |
| <a href="https://livekit.io/"><img src="docs/assets/readme/logos/livekit.png" width="28" height="28" alt="LiveKit">&nbsp;<strong>LiveKit</strong></a> | Shared audio rooms and translated tracks | A Python worker joins the room. LiveKit transports audio, while final text is stored in Convex |
| <a href="https://cartesia.ai/"><img src="docs/assets/readme/logos/cartesia.png" width="28" height="28" alt="Cartesia">&nbsp;<strong>Cartesia</strong></a> | English and Mandarin translated speech | Configured voices are selected by language and speaker voice profile. Missing voices leave text available |
| <a href="https://backboard.io/"><img src="docs/assets/readme/logos/backboard.png" width="28" height="28" alt="Backboard">&nbsp;<strong>Backboard</strong></a> | Company-scoped memory across incidents | Recalls operator preferences and past context for the agents. Every proposal still requires current human approval |
| <a href="https://www.tigerdata.com/"><img src="docs/assets/readme/logos/tigerdata.png" width="28" height="28" alt="Tiger Data">&nbsp;<strong>Tiger&nbsp;Data</strong></a> · <a href="https://www.postgresql.org/"><img src="docs/assets/readme/logos/postgresql.png" width="28" height="28" alt="PostgreSQL">&nbsp;<strong>PostgreSQL</strong></a> | Historical observations and time-series queries | The adapter preserves source, evidence version, observation time, and simulation labels. Convex remains the application authority |
| <a href="https://factory.com/"><img src="docs/assets/readme/logos/factory.png" width="28" height="28" alt="Factory">&nbsp;<strong>Factory&nbsp;Droid&nbsp;SDK</strong></a> | Schedule preview and authorized file artifact | A Node.js worker prepares the schedule file with Droid and commits the reserved preview. Approvals and re-screening stay with the application |

### Development tools

<a href="https://cursor.com/"><img src="docs/assets/readme/logos/cursor.png" width="28" height="28" alt="Cursor">&nbsp;<strong>Cursor</strong></a> was part of our development workflow for writing, refactoring, and debugging the frontend, Convex backend, and Python services. We also used [**Grok Bot**](https://x.ai/) to plan the project and coordinate work between teammates. Git and <a href="https://github.com/"><img src="docs/assets/readme/logos/github.png" width="28" height="28" alt="GitHub">&nbsp;<strong>GitHub</strong></a> keep the independently developed components together.

## Real data and reproducible calculations

The main catalog contains **19,468 unique space objects** in the pinned CelesTrak snapshot `gp-20261024T2134Z`. Each source file has a recorded URL, fetch time, record count, and SHA-256 checksum.

| Source | What it supplies | How we use it |
|---|---|---|
| <a href="https://celestrak.org/"><img src="docs/assets/readme/logos/celestrak.png" width="28" height="28" alt="CelesTrak"></a> [**CelesTrak GP**](https://celestrak.org/NORAD/documentation/gp-data-formats.php) | OMM orbital elements for active spacecraft and selected debris groups | The shared real-mode catalog and SGP4 calculations |
| **CelesTrak SATCAT** | Object metadata, including ownership, launch information, and object type | Satellite details and classification. Demo assignments remain separate from real ownership |
| [**CelesTrak SOCRATES**](https://celestrak.org/SOCRATES/) | Reference conjunction records and supplied maximum probability | An independent comparison for our screening, with source and epoch differences visible |
| <a href="https://www.nasa.gov/"><img src="docs/assets/readme/logos/nasa.png" width="28" height="28" alt="NASA"></a> [**NASA ISS ephemeris**](https://spotthestation.nasa.gov/trajectory_data.cfm) | Public ISS trajectory data | Input to the separately labeled, simulated maneuver-verification replay |
| <a href="https://www.nasa.gov/"><img src="docs/assets/readme/logos/nasa.png" width="28" height="28" alt="NASA"></a> **NASA GIBS** · <a href="https://www.esri.com/"><img src="docs/assets/readme/logos/esri.png" width="28" height="28" alt="Esri"></a> **Esri** · **NOAA** · **GDACS** · **EUMETSAT** | Earth imagery and weather/context layers | Visual context on the globe, separate from collision evidence |

Real mode uses OMM directly. Development mode keeps the TLE catalog and synthetic scenarios for interface work. OMM is a data format, not an automatic accuracy improvement. Source quality, epoch, and the propagation method still matter.

The orbital service calculates geometry. It does not invent covariance, calculate a replacement collision probability from miss distance, or attach the original probability to a proposed maneuver as a predicted result. SOCRATES values retain their `max_prob` label.

[Data layout and preparation](data/README.md) · [Orbital-service contract](services/orbit/docs/contract.md) · [Numerical decisions](services/orbit/docs/decisions.md)

### Recorded component validation

The orbital-service documentation records a comparison against **200 SOCRATES rows with matching orbital inputs**: 200 matched, a 0.001-second 95th-percentile closest-approach-time error, and a 7-metre 95th-percentile miss-distance error. The other 38,190 rows have different orbital inputs and are reported separately as data differences.

That comparison uses the pinned TLE validation snapshot, separate from the later OMM catalog shown in real mode. The figures describe the matching-input subset. Other source and epoch differences remain visible in the results. [Method and limitations](services/orbit/README.md#limits-say-them-in-the-pitch)

## Inside the submission

| Component | What it provides |
|---|---|
| **Globe and catalog** | A Three.js orbital view, satellite details, source-linked OMM data, and a TLE development mode |
| **Fleet screening** | Assigned-spacecraft scans, calculated maneuver candidates, catalog re-screening, persisted jobs, and coverage records |
| **Shared decisions** | Workflow rooms, notifications, proposal selection, current-revision approvals, and a read-only observer view |
| **AI agents** | Claude analysis and policy evaluation, Gemini coordination, and independent Grok reasoning checks |
| **Multilingual calls** | LiveKit audio with English, Russian, and Mandarin translation, original text, checked values, and translated speech |
| **Memory and history** | Company-scoped Backboard context and Tiger Data observations with timestamps and source labels |
| **Schedule artifacts** | A Factory Droid worker that prepares a reviewable file and records an exact, versioned commit |

The hackathon scenarios use simulated encounters, policies, assignments, and maneuvers alongside real catalog data. The verification replay is labeled simulated. Schedule artifacts record coordination decisions. Spacecraft execution stays with the operator.

## Run locally

### Interface and development scenarios

Use Node.js 22.13 or newer in the Node 22 line and npm. The frontend and backend are separate packages.

```sh
git clone https://github.com/ksavkin/OrbitCall.git
cd OrbitCall/web
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). The frontend can run without backend credentials for development scenarios. Use the **Dev** switch to explore the local simulation. To use the committed TLE snapshot without a live CelesTrak request, start it with `ORBITCALL_OFFLINE=1 npm run dev`.

### Connect an application backend

Install the root package in a separate terminal and create your own Convex development deployment. The team's shared demo deployment has its own release process.

```sh
cd OrbitCall
npm ci
npm run check
npx convex dev
```

Set the public connection values in `web/.env.local`, then restart Next.js:

```dotenv
NEXT_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
NEXT_PUBLIC_AUTH0_DOMAIN=<your-tenant>.auth0.com
NEXT_PUBLIC_AUTH0_CLIENT_ID=<your-public-client-id>
```

Keep provider keys in the server that uses them. The backend requires the configured model IDs as well as API keys. Voice also needs LiveKit, Cartesia/Grok voice IDs, and a scoped Convex callback credential. These are documented in the component guides rather than copied into the frontend environment.

| Setup | Guide |
|---|---|
| Backend, models, and data contracts | [Master roadmap](docs/master-roadmap.md), [API specification](docs/specification.md), [Analyst guide](docs/phase1-andrew.md) |
| Python orbital service and pinned data | [Orbital-service README](services/orbit/README.md) |
| Voice worker, provider configuration, and smoke checks | [Voice-worker README](services/voice/README.md) |
| Factory schedule worker and SDK | [Scheduler README](services/scheduler/README.md) |
| DigitalOcean, Docker Compose, and Caddy | [Deployment runbook](deploy/README.md) |
| Frontend and design conventions | [Web README](web/README.md), [UI design system](docs/adil/design-system.md) |

### Checks

```sh
# Repository root: backend TypeScript and tests
npm run check

# web/: frontend TypeScript, lint, and production build
npx tsc --noEmit
npm run lint
npm run build
```

The root test suite uses fixtures and mocked provider responses. Python service test commands and data prerequisites are in their READMEs. Live API success and a complete deployed rehearsal are separate checks.

## What we learned

Small details can change an orbital verdict. A distance just below a threshold must not become a pass because of display rounding. A propagation failure must remain missing coverage rather than disappear from a successful scan.

AI output needs the same care. Numerical values come from tools, references must identify real records, and a result can become stale while a model is answering. Clear ownership of data and explicit human decisions made the individual components easier to reason about and test.

## Vision

OrbitCall brings people, orbital evidence, and AI assistance into the same decision. We see it growing into an international coordination network where operators of a few spacecraft and teams managing large constellations can work through encounters together.

The wider goal is fewer avoidable maneuvers, less fuel spent resolving orbital conflicts, and a lower risk of creating more debris. Connecting operator-supplied trajectories and standard Conjunction Data Messages would give those discussions better evidence, while explicit approvals keep each operator responsible for their spacecraft.

## Project documents

The [master roadmap](docs/master-roadmap.md) is the source of truth for the agreed scope and stack. The README is the public overview. Detailed implementation notes may describe an earlier milestone, so use the current source and contract when checking a component.

- [Assigned-fleet user flow](docs/user-flow.md)
- [Frontend/backend specification](docs/specification.md)
- [Functionality and stable requirement IDs](docs/functionality.md)
- [Sponsor roles and submission evidence](docs/sponsors.md)
- [Operator Advocate implementation](docs/operator-advocate-v1.md)
- [Agent integration plan](docs/andrew/rounds-plan.md)

## Team

[**Adilbek Bazarkulov**](https://devpost.com/bazarkua) · [**Konstantin Savkin**](https://devpost.com/k-e-savkin) · [**Andrew Yu**](https://devpost.com/AndrewYYu) · [**Freja R**](https://devpost.com/96528025)

[Live demo](https://orbitcall.vercel.app/) · [Devpost](https://devpost.com/software/orbitcall) · [Source](https://github.com/ksavkin/OrbitCall)
