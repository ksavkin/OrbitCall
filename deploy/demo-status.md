# Hackathon deployment status

Recorded 2026-10-25. This is a temporary demo deployment; readiness remains pending the checks below.

## Host and release

- DigitalOcean Droplet: `orbitcall-demo`, `142.93.127.239`, Ubuntu 24.04, SSH-key login as `root`.
- Orbit URL: `https://orbitcall.142-93-127-239.sslip.io/orbit`.
- The free sslip.io hostname resolves from the embedded IP. This demo uses it instead of a purchased domain;
  HTTPS is still terminated by Caddy with a publicly trusted certificate. Keep the IP stable while demonstrating.
- Orbit container source: `b4ddd0c533c1bea6d2b507c1cf1879a911c52319`.
- Release directory: `/opt/orbitcall/releases/b4ddd0c533c1bea6d2b507c1cf1879a911c52319`;
  `/opt/orbitcall/current` points to it.
- Environment: `/opt/orbitcall/demo.env`, mode 600, inside a mode-700 directory. No credentials are in this document.
- Satellite data: writable Docker volume `orbitcall_orbit_data`, seeded from the committed files only.
- Snapshot: `gp-20261024T2134Z`, 19,468 objects. No new CelesTrak request was made during setup.
- Convex: `basic-wildcat-552` (production). `ORBIT_SERVICE_URL` and `ORBIT_SERVICE_TOKEN` were set and read back
  without displaying their values.
- Docker 29.9.2, Compose 5.6.1, Caddy 2.11.7. Public ports: SSH 22 and HTTP(S) 80/443; no orbit/voice admin ports.

## Checks completed before resize

- Public HTTPS `/orbit/health`: 200, `ok: true`, expected snapshot and object count.
- Unauthenticated `/orbit/snapshot`: 401. Unrecognized public route: 404.
- Authenticated `/screen` accepted a 72-hour scan of `56191`, `56193`, `56200`, `62382`.
- xAI and Anthropic model-list requests and the Cartesia voice-list request returned 200 using the existing
  production credentials. This establishes API access, not a successful speech/translation session.
- The new Convex deployment check passed TypeScript and the backend suite: 859 tests across 21 files.

## Memory finding and resize

The initial Droplet has 512 MB RAM (458 MiB usable), one CPU, and a 10 GB disk. A 1 GiB swap file was added at
`/swapfile.orbitcall` and persisted in `/etc/fstab` to allow installation and measurement without another paid
resource. During the full scan the orbit process used approximately 650 MB across RAM and swap. Samples showed
79–81% I/O wait. This size is not accepted for the live demo.

Andrew selected a CPU-and-RAM-only resize to 4 GB / 2 CPUs. The host was asked to shut down cleanly so the resize
can be applied in DigitalOcean. Disk data, environment settings and certificate volumes are retained.

The pre-resize scan was interrupted for that resize; do not report it as a completed or comprehensive screen:

- Job/scan/evidence ID: `ops-20261025T091411Z`.
- Window: `2026-10-25T09:14:11Z` through `2026-10-28T09:14:11Z`.
- Last observed state: running, zero completed primaries.
- Job snapshot saved on the host at `/opt/orbitcall/screen-before-resize.json`.
- A Convex `ops:checkOrbit` attempt during the loaded scan hit its five-second health timeout.

## Remaining after resize

1. Confirm 4 GB / 2 CPUs and service restart; rerun HTTPS and authenticated checks.
2. Repeat the four-object, 72-hour screen. Record `runtimeS`, `counts.eventsFound`, `coverage.complete`, and the
   exact window. Validate the finished job with `ops:checkOrbit` from production Convex.
3. Build and start the voice container. Select and test English/Mandarin Cartesia voices and a Russian xAI voice;
   record those IDs. They remain unset in the current environment, so translated audio is not yet ready.
4. Check LiveKit registration, the worker health endpoint, and speech in an isolated demo room before presenting
   live translation as working. Provider metadata checks alone do not complete this item.
5. Rehearse the actual website flow with the team's Round 3 wiring. Hosting these services does not itself wire
   the Run Scan button, room discussions or candidate publication into the UI.

After the hackathon, save the needed results and destroy the Droplet to stop its billing. Powering it off does not
stop DigitalOcean charging for the reserved server. Preserve any required data before destruction.
