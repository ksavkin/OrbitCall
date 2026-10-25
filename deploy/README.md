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
| `orbit` | `ghcr.io/ksavkin/orbitcall-orbit:$RELEASE_TAG`, built from `services/orbit/` | Port 3610 on the Compose network only, reached through Caddy. One Uvicorn worker: the catalog lives in memory | `orbit_data` at `/service/data` (writable): pinned snapshots, TLE groups, replay and cached validation in; `jobs/`, `sim/` and `validation/` written at runtime | `GET http://127.0.0.1:3610/health` inside the container, with Python's `urllib` |
| `voice` | `ghcr.io/ksavkin/orbitcall-voice:$RELEASE_TAG`, built from `services/voice/` | Outbound only, to LiveKit Cloud, xAI, Anthropic, Cartesia and Convex. No published port, no Caddy route | None. Phrase buffers are short-lived; final phrases go to Convex | `GET http://127.0.0.1:8090/health` inside the container, with Python's `urllib`. 200 only when xAI, Anthropic, every configured TTS voice, the Convex settings and the LiveKit registration are ready; 503 while not ready or for 60 s after a runtime failure |
| `caddy` | `caddy:2.11.7` | Publishes 80 and 443 (TCP, plus UDP for HTTP/3) | `caddy_data` (certificates), `caddy_config` | None; check through the routes below |

All three restart `unless-stopped` and log as JSON files rotated at 10 MB × 5. Compose uses the fixed project name
`orbitcall`, so volumes are named `orbitcall_orbit_data`, `orbitcall_caddy_data` and `orbitcall_caddy_config`.

The voice worker connects outward to LiveKit Cloud. It is not the LiveKit media server, and nothing on the Droplet
accepts audio connections.

The Factory schedule worker (`services/scheduler/`) is not in this file yet. It joins as a fourth container with its
own workspace volume and a `/scheduler/*` route when that service exists.

## Routes

| Public URL | Goes to | Authentication |
|---|---|---|
| `https://$ORBITCALL_API_HOST/orbit/health` | `orbit:3610/health` | None (readiness and loaded snapshot version) |
| `https://$ORBITCALL_API_HOST/orbit/<path>` | `orbit:3610/<path>`, prefix stripped | The orbit service's `ORBIT_SERVICE_TOKEN` |
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
| `ORBIT_SNAPSHOT_ID` | `orbit` | No | The team snapshot to load (`snapshots/<id>/` in the data volume); defaults to `gp-20261024T2134Z`. Set it here when the team pins a new snapshot |
| `LIVEKIT_URL` | `voice` | No | LiveKit Cloud project URL |
| `LIVEKIT_API_KEY` | `voice` | Yes | LiveKit project key |
| `LIVEKIT_API_SECRET` | `voice` | Yes | LiveKit project secret |
| `XAI_API_KEY` | `voice` | Yes | xAI key (STT and Russian TTS) |
| `ANTHROPIC_API_KEY` | `voice` | Yes | Anthropic key (translation) |
| `CARTESIA_API_KEY` | `voice` | Yes | Cartesia key (English and Mandarin TTS) |
| `XAI_STT_MODEL` | `voice` | No | Locked: `grok-voice-transcribe-2.0` (the Compose default) |
| `TRANSLATION_MODEL` | `voice` | No | Locked: `claude-sonnet-5-5` (the Compose default) |
| `CARTESIA_MODEL_ID` | `voice` | No | Locked: `sonic-3.6-2026-08-27` (the Compose default) |
| `CARTESIA_VOICE_EN` | `voice` | No | Tested English voice ID, recorded in the demo manifest. Missing: English is text-only |
| `CARTESIA_VOICE_ZH` | `voice` | No | Tested Mandarin voice ID, recorded in the demo manifest. Missing: Mandarin is text-only |
| `XAI_TTS_VOICE_ID` | `voice` | No | Tested Russian voice ID, recorded in the demo manifest. Missing: Russian is text-only |
| `CONVEX_SITE_URL` | `voice` | No | The shared Convex deployment's `.convex.site` URL (HTTP actions) |
| `CALL_SERVICE_TOKEN` | `voice` | Yes | Sent as `x-call-service-token` to Convex `POST /call/phrase`; Convex's `CALL_SERVICE_TOKEN` holds the same value |

The orbit image already sets `ORBIT_DATA=/service/data` and `ORBIT_CATALOG_MODE=omm`; the volume is mounted there.
Its other settings keep their defaults (`ORBIT_SCREEN_DEADLINE_S` 480, `ORBIT_JOB_WORKERS` 2); add them to the
Compose file only to change them. Do not set `ORBIT_SNAPSHOT_DIR`: it is not the data folder but an override that loads
one alternative OMM snapshot. Locked model IDs come from the roadmap §4 registry; changing one is a lock revision.

Generate the two shared tokens on the host, for example `openssl rand -hex 32`, and set the same values in Convex.

## Deploy

Run from the checked-out release commit at the repository root.

### 1. Seed the orbit data volume (first deploy, or a new pinned snapshot)

The orbit service reads one data folder built by its own script from the checkout: the pinned OMM and SOCRATES
snapshots (`data/snapshots/`), the TLE groups (`web/data/snapshot/`), and the replay and cached validation shipped in
`services/orbit/data/`. Build it outside the checkout (the script refuses a target inside it), then copy it into the
volume:

```sh
services/orbit/setup-data.sh "$PWD" /tmp/orbit-data
docker volume create orbitcall_orbit_data
docker run --rm \
  -v orbitcall_orbit_data:/dst \
  -v /tmp/orbit-data:/src:ro \
  alpine cp -a /src/. /dst/
```

The volume must stay writable: the service writes `jobs/`, `sim/` and `validation/` into it, and copying a new seed
over it keeps existing job records. The service refuses to start if the pinned snapshot is missing or fails its sha256
check. After the team pins a new snapshot, rerun both commands, set `ORBIT_SNAPSHOT_ID` if it changed, and
`docker compose ... restart orbit`.

### 2. Start the services (roadmap §13 Step 3)

```sh
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml pull
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml up -d
docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml ps
```

If the release images are not in the registry, build them on the host with the same tag, then pull only Caddy:
`docker compose --env-file /opt/orbitcall/demo.env -f deploy/docker-compose.demo.yml build orbit voice` and
`... pull caddy`, then `up -d` as above.

## Verify

- `docker compose ... ps` shows `orbit` and `voice` as `healthy` and `caddy` as running. `voice` turns healthy only
  once every provider it uses and its LiveKit registration answer. If it stays unhealthy, `docker compose ... logs
  voice` shows which check fails.
- `curl -fsS https://$ORBITCALL_API_HOST/orbit/health` returns readiness and `gp-20261024T2134Z` (or the configured
  `ORBIT_SNAPSHOT_ID`).
- `curl -s -o /dev/null -w '%{http_code}' https://$ORBITCALL_API_HOST/orbit/snapshot` without the token is rejected
  by the orbit service, and `https://$ORBITCALL_API_HOST/` returns `404`.
- Call `/orbit/health` from the Convex action path too, not only from a laptop.
- Logs: `docker compose ... logs -f orbit voice` (structured, with job IDs).

A running or healthy container does not prove provider access or numerical readiness. Run one real screening job
through Convex and join one LiveKit room with speech in each language before calling the host ready.

The internal `ops:checkOrbit` action checks readiness from the deployed Convex runtime and rejects the wrong
snapshot. It can also read and validate an existing screening job through the production service credential:

```sh
npx convex run ops:checkOrbit '{"snapshotId":"gp-20261024T2134Z"}' --prod
npx convex run ops:checkOrbit '{"snapshotId":"gp-20261024T2134Z","screen":{"jobId":"<job-id>","scanId":"<scan-id>","evidenceVersion":"<evidence-version>"}}' --prod
```

This check does not start a scan or write application data. Its output contains readiness, counts, coverage,
runtime and a sanitized job error; it never returns credentials or the full encounter list. A health-only result
does not establish that the service token works; include an existing job to check the authenticated path.

The current hackathon host, completed scan and voice evidence, and remaining website rehearsal are recorded in
[demo-status.md](demo-status.md).

## Assumed names, confirm with the service code

These were chosen here because the roadmap does not name them. Rename them in this folder if the services use
different ones. The service variables are the services' own: orbit's from `services/orbit/README.md`, voice's from
`services/voice/README.md`.

- `ORBITCALL_API_HOST`: Caddy's site address.
- `RELEASE_TAG` and the image names `ghcr.io/ksavkin/orbitcall-orbit` and `ghcr.io/ksavkin/orbitcall-voice`. No CI job
  publishes them yet.

Other assumptions about the services:

- Both services are confirmed against their code. Orbit (`python:3.12-slim`, Uvicorn on 3610, one worker): `/health`
  needs no token and returns the loaded `snapshotId` and object count, and every other route checks
  `X-Service-Token`. Voice (`python:3.12-slim`, user `worker`, LiveKit Agents): its health server listens on
  `HEALTH_PORT` 8090 inside the container only, and its other settings (`LIVEKIT_AGENT_NAME`, `STT_ENDPOINTING_MS`,
  `STT_KEYTERMS`, `MAX_ROOMS`, `WORKER_PORT`, `LOG_LEVEL`) keep their defaults; add them to the Compose file only to
  change them.
- The orbit service has no backend callback credential; roadmap §13 Step 4 adds one only if that path is implemented.

## Out of scope

- The Factory schedule worker (`services/scheduler/`), its workspace volume and route.
- Vercel (`web/`) and Convex (root `convex/`) deployment and their environment values.
- CI that builds and pushes the release images.
