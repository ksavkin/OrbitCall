# Hackathon deployment status

Recorded 2026-10-25. The orbit API and voice worker passed live infrastructure checks on the resized Droplet.
This does not complete the website rehearsal or the remaining Round 3/4 application wiring.

## Host and release

- DigitalOcean Droplet: `orbitcall-demo`, `142.93.127.239`, Ubuntu 24.04, SSH-key login as `root`.
- Verified after resize: 2 CPUs, 3,915 MiB usable RAM (4 GB plan), 77 GiB filesystem (approximately 80 GB disk).
  The existing 1 GiB swap file remains available; usage was zero after the scan and during the voice test.
- Orbit URL: `https://orbitcall.142-93-127-239.sslip.io/orbit`.
- The free sslip.io hostname resolves from the embedded IP. HTTPS is terminated by Caddy with a publicly trusted
  certificate. Keep the IP stable while demonstrating.
- Orbit and voice container source: `b4ddd0c533c1bea6d2b507c1cf1879a911c52319`, built on the Droplet.
- Release directory: `/opt/orbitcall/releases/b4ddd0c533c1bea6d2b507c1cf1879a911c52319`;
  `/opt/orbitcall/current` points to it.
- Environment: `/opt/orbitcall/demo.env`, mode 600, inside a mode-700 directory. No credentials are in this document.
- Satellite data: writable Docker volume `orbitcall_orbit_data`, seeded from the committed files and validation cache.
- Snapshot: `gp-20261024T2134Z`, 19,468 objects. No new CelesTrak request was made during setup.
- Convex: `basic-wildcat-552` (production). Orbit URL/token and the matching call/LiveKit credentials are configured.
- Docker 29.9.2, Compose 5.6.1, Caddy 2.11.7. Public ports: SSH 22 and HTTP(S) 80/443; no orbit/voice admin ports.
- All three containers run; orbit and voice report healthy. After the tests, the host had 2,621 MiB available RAM.

## Orbit checks

- Public HTTPS `/orbit/health`: 200, `ok: true`, expected snapshot and 19,468 objects.
- Unauthenticated `/orbit/snapshot`: 401. Unrecognized public route: 404.
- Authenticated `POST /screen` completed a 72-hour scan of `56191`, `56193`, `56200`, `62382`.
- Job/scan/evidence ID: `ops-20261025T092812Z`.
- Window: `2026-10-25T09:28:12Z` through `2026-10-28T09:28:12Z`.
- `runtimeS: 202.1`, `eventsFound: 474`, `primariesCompleted: 4`, `pairsChecked: 42978`.
- `coverage.complete: true`, `timedOut: false`, no excluded objects or reported coverage gaps. This covers the
  pinned catalog, not every object in space; an encounter count is not a count of confirmed collisions.
- The deployed production Convex `ops:checkOrbit` action read the completed job using the service credential and
  validated its snapshot and evidence pins. Job creation used the service API directly; this does not verify the
  website's Run Scan button or `scans.startMine` wiring.

Sanitized result: [screen.json](evidence/2026-10-25/screen.json). Full service output remains on the host at
`/opt/orbitcall/screen-result.json`.

## Voice checks

The deployed worker joined an isolated, simulated LiveKit room, `ops-voice-20261025T093102`. Three SDK clients
published provider-generated synthetic speech as microphone tracks, one phrase in each language. Each listener
received non-silent translated audio in both other languages: all six directions passed. First translated audio
arrived 4.6–5.3 seconds after the source clip ended in this test.

Production Convex stored three final phrases (one per source language), each with both translations marked `ok`
and no phrase errors. The LiveKit test room was closed after disconnecting the clients. The worker's internal
health endpoint returned 200 with `ready: true`, `degraded: false`, and no recent errors after the test.

| Language | TTS provider | Tested voice | ID |
|---|---|---|---|
| English | Cartesia | Skylar | `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4` |
| Mandarin | Cartesia | Yu-Hsin | `0f5ac064-30c7-4cf6-8748-d275f682a0d5` |
| Russian | xAI | Eve | `eve` |

Pinned models: `grok-voice-transcribe-2.0`, `claude-sonnet-5-5`, and `sonic-3.6-2026-08-27`.
Voice metadata access and actual speech synthesis both succeeded before the room test.

Sanitized results, per-direction timings, and source phrases: [voice.json](evidence/2026-10-25/voice.json).
This verifies the deployed worker, providers, LiveKit audio, and Convex phrase ingestion. It is not a human
microphone/browser rehearsal, a native-speaker translation review, or a test of maneuver numbers in speech.

## Code validation

The internal orbit deployment check passed the root TypeScript check and 859 backend tests across 21 files.
Generated Convex bindings are left out of the task branch, following issue #6; regenerate on `main` after merge.

## Initial sizing finding

The initial 512 MB / one-CPU Droplet exhausted RAM during screening and showed 79–81% I/O wait with swap in use.
The pre-resize scan `ops-20261025T091411Z` was interrupted for shutdown with zero primaries completed. Its last
state is retained at `/opt/orbitcall/screen-before-resize.json`; it is not successful screening evidence. The
post-resize scan above completed without that memory pressure.

## Remaining demo work

1. Finish the roadmap's application wiring and rehearse the website flow on all four screens. Service readiness
   alone does not verify room discussions, candidate publication, or approvals in the UI.
2. Rehearse real microphones and the displayed captions/audio in each language, including maneuver numbers.
3. Implement and deploy the Factory schedule worker in the planned Andrew Round 3/4 tasks, then connect the
   approval and re-screen flow in Kostya's scheduler wiring task.

After the hackathon, save the needed results and destroy the Droplet to stop its billing. Powering it off does not
stop DigitalOcean charging for the reserved server. Preserve any required data before destruction.
