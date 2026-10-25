# Deploy

The DigitalOcean half of the OrbitCall demo: one CPU Droplet running the orbital API (`services/orbit/`), the voice
translation worker (`services/voice/`) and a Caddy HTTPS proxy as separate Docker Compose containers. It follows the
[master roadmap](../docs/master-roadmap.md) §12 (deployment map) and §13 Steps 3–4 (DigitalOcean, secrets). Vercel and
Convex deploy separately (§13 Steps 5–6).

| File | What |
|---|---|
| `docker-compose.demo.yml` | Services `orbit`, `voice`, `caddy`; volumes; health checks; restart and log rotation |
| `Caddyfile` | The only public routes: `/orbit/health` and `/orbit/*` on one hostname |

## Services

| Service | Image | Network | Persistent state | Health check |
|---|---|---|---|---|
| `orbit` | `ghcr.io/ksavkin/orbitcall-orbit:$RELEASE_TAG`, built from `services/orbit/` | Port 8000 on the Compose network only, reached through Caddy | `orbit_snapshots` (read-only, pinned snapshots), `orbit_results` (numerical jobs and results) | `GET http://127.0.0.1:8000/health` inside the container, with Python's `urllib` |
| `voice` | `ghcr.io/ksavkin/orbitcall-voice:$RELEASE_TAG`, built from `services/voice/` | Outbound only, to LiveKit Cloud, xAI, Anthropic, Cartesia and Convex. No published port, no Caddy route | None. Phrase buffers are short-lived; final phrases go to Convex | Process check: PID 1 is the Python worker |
| `caddy` | `caddy:2` | Publishes 80 and 443 (TCP, plus UDP for HTTP/3) | `caddy_data` (certificates), `caddy_config` | None; check through the routes below |

All three restart `unless-stopped` and log as JSON files rotated at 10 MB × 5. Compose uses the fixed project name
`orbitcall`, so volumes are named `orbitcall_orbit_snapshots`, `orbitcall_orbit_results`, `orbitcall_caddy_data` and
`orbitcall_caddy_config`.

The voice worker connects outward to LiveKit Cloud. It is not the LiveKit media server, and nothing on the Droplet
accepts audio connections.

The Factory schedule worker (`services/scheduler/`) is not in this file yet. It joins as a fourth container with its
own workspace volume and a `/scheduler/*` route when that service exists.

## Routes

| Public URL | Goes to | Authentication |
|---|---|---|
| `https://$ORBITCALL_API_HOST/orbit/health` | `orbit:8000/health` | None (readiness and loaded snapshot version) |
| `https://$ORBITCALL_API_HOST/orbit/<path>` | `orbit:8000/<path>`, prefix stripped | The orbit service's `ORBIT_SERVICE_TOKEN` |
| Anything else | `404` | n/a |

Caddy only terminates HTTPS and routes. It does not check credentials: the orbit service itself must reject every
request except `/health` that lacks `ORBIT_SERVICE_TOKEN` (sent as the `X-Service-Token` header, per
[specification](../docs/specification.md) Appendix A). Convex sets `ORBIT_SERVICE_URL` to
`https://$ORBITCALL_API_HOST/orbit` and holds the same token. Caddy's access log drops the `X-Service-Token` header
(it redacts `Authorization` by default).

No admin or worker ports are published. SSH stays limited to the team.

## Prerequisites

- A Docker-capable CPU Droplet with Docker Engine and the Compose plugin. Record its region and address.
- A hostname the team controls, for example `api.<demo-domain>`, with a DNS A record pointing at the Droplet. Caddy
  obtains the certificate itself, so ports 80 and 443 must be reachable before the first `up`. `api.<demo-domain>`
  is a placeholder until a domain is registered.
- The repository checked out on the host at the release commit, and images for that commit pushed to the registry
  (or built on the host, see below).

## Environment file

Create `/opt/orbitcall/demo.env` on the host (`chmod 600`, owned by the deploying user). It is never committed. It
holds `NAME=value` lines for every variable below. Compose reads it for interpolation only, and each container
receives just the names listed for it, so the voice worker never sees the orbit token and the reverse.

| Variable | Used by | Secret | Value |
|---|---|---|---|
| `RELEASE_TAG` | Compose (image tags) | No | The release commit SHA the host has checked out; images must carry the same tag |
| `ORBITCALL_API_HOST` | `caddy` | No | The controlled hostname, e.g. `api.<demo-domain>` |
| `ORBIT_SERVICE_TOKEN` | `orbit` | Yes | Same value as Convex's `ORBIT_SERVICE_TOKEN` |
| `ORBIT_SNAPSHOT_ID` | `orbit` | No | Pinned snapshot folder; defaults to `gp-20261024T2134Z` |
| `LIVEKIT_URL` | `voice` | No | LiveKit Cloud project URL |
| `LIVEKIT_API_KEY` | `voice` | Yes | LiveKit project key |
| `LIVEKIT_API_SECRET` | `voice` | Yes | LiveKit project secret |
| `XAI_API_KEY` | `voice` | Yes | xAI key (STT and Russian TTS) |
| `ANTHROPIC_API_KEY` | `voice` | Yes | Anthropic key (translation) |
| `CARTESIA_API_KEY` | `voice` | Yes | Cartesia key (English and Mandarin TTS) |
| `XAI_STT_MODEL` | `voice` | No | Locked: `grok-voice-transcribe-2.0` |
| `TRANSLATION_MODEL` | `voice` | No | Locked: `claude-sonnet-5-5` |
| `CARTESIA_MODEL_ID` | `voice` | No | Locked: `sonic-3.6-2026-08-27` |
| `CARTESIA_VOICE_ID_EN` | `voice` | No | Tested English voice ID, recorded in the demo manifest |
| `CARTESIA_VOICE_ID_ZH` | `voice` | No | Tested Mandarin voice ID, recorded in the demo manifest |
| `XAI_TTS_VOICE_ID` | `voice` | No | Tested Russian voice ID, recorded in the demo manifest |
| `CONVEX_SITE_URL` | `voice` | No | The shared Convex deployment's `.convex.site` URL (HTTP actions) |
| `VOICE_CALLBACK_TOKEN` | `voice` | Yes | Narrowly scoped credential the worker presents to Convex HTTP actions; Convex holds the same value |

`ORBIT_SNAPSHOT_DIR=/data/snapshots` and `ORBIT_RESULTS_DIR=/data/results` are fixed in the Compose file because they
are the container-side mount points, not host settings. Locked model IDs come from the roadmap §4 registry; changing
one is a lock revision.

Generate the two shared tokens on the host, for example `openssl rand -hex 32`, and set the same values in Convex.

## Deploy

Run from the checked-out release commit at the repository root (roadmap §13 Step 3):

```sh
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml pull
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml up -d
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml ps
```

If the release images are not in the registry, build them on the host with the same tag, then pull only Caddy:
`docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml build orbit voice` and
`... pull caddy`, then `up -d` as above.

### Seed the snapshot volume (first deploy, or a new pinned snapshot)

Snapshot folders are immutable, so copying all of `data/snapshots/` from the checkout is safe and repeatable:

```sh
docker run --rm \
  -v orbitcall_orbit_snapshots:/dst \
  -v "$PWD/data/snapshots:/src:ro" \
  alpine cp -a /src/. /dst/
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml restart orbit
```

The volume exists after the first `up -d`; or create it with `docker volume create orbitcall_orbit_snapshots`.

## Verify

- `docker compose ... ps` shows `orbit` as `healthy` and `voice` and `caddy` as running.
- `curl -fsS https://$ORBITCALL_API_HOST/orbit/health` returns readiness and `gp-20261024T2134Z` (or the configured
  `ORBIT_SNAPSHOT_ID`).
- `curl -s -o /dev/null -w '%{http_code}' https://$ORBITCALL_API_HOST/orbit/snapshot` without the token is rejected
  by the orbit service, and `https://$ORBITCALL_API_HOST/` returns `404`.
- Call `/orbit/health` from the Convex action path too, not only from a laptop.
- Logs: `docker compose ... logs -f orbit voice` (structured, with job IDs).

A running or healthy container does not prove provider access or numerical readiness. Run one real screening job
through Convex and join one LiveKit room with speech in each language before calling the host ready.

## Assumed names, confirm with the service code

These were chosen here because the roadmap does not name them. Rename them in this folder if the services use
different ones.

- `ORBIT_SNAPSHOT_DIR`, `ORBIT_RESULTS_DIR`: the snapshot and results paths the orbit service reads.
- `ORBIT_SNAPSHOT_ID`: which pinned snapshot folder under `ORBIT_SNAPSHOT_DIR` it loads and reports in `/health`.
- `VOICE_CALLBACK_TOKEN`: the voice worker's Convex callback credential.
- `CARTESIA_VOICE_ID_EN`, `CARTESIA_VOICE_ID_ZH`: the per-language Cartesia voice IDs.
- `ORBITCALL_API_HOST`: Caddy's site address.
- `RELEASE_TAG` and the image names `ghcr.io/ksavkin/orbitcall-orbit` and `ghcr.io/ksavkin/orbitcall-voice`. No CI job
  publishes them yet.

Other assumptions about the services:

- Each service has a `Dockerfile` at its directory root, and both images include `python` (used by the health checks).
- The orbit service listens on port 8000 (Uvicorn), serves `/health` without the token, and checks
  `ORBIT_SERVICE_TOKEN` itself on every other route.
- The orbit service only reads snapshots (the volume is mounted read-only) and writes jobs and results under
  `ORBIT_RESULTS_DIR`.
- The voice worker exposes no HTTP route, so its health check only confirms the Python process is running. If it is
  built on LiveKit Agents, the built-in worker health server (port 8081 by default) is a better check.
- The orbit service has no backend callback credential; roadmap §13 Step 4 adds one only if that path is implemented.

## Out of scope

- The Factory schedule worker (`services/scheduler/`), its workspace volume and route.
- Vercel (`web/`) and Convex (root `convex/`) deployment and their environment values.
- CI that builds and pushes the release images.
