#!/usr/bin/env python3
"""Build a self-contained architecture SVG from the checked-in brand and role icons."""

from __future__ import annotations

import base64
from html import escape
from pathlib import Path

BASE = Path(__file__).resolve().parent
WIDTH, HEIGHT = 2000, 1995
PALETTES = {
    "identity": ("#fff9f3", "#ead1ba", "#b36b31"),
    "client": ("#f2f7ff", "#c4d8f5", "#3a6fb4"),
    "media": ("#effaf8", "#b4ded4", "#21776b"),
    "core": ("#f3efff", "#bba8e5", "#7451b5"),
    "claude": ("#fff4ed", "#edc9af", "#ac6942"),
    "gemini": ("#f4f5ff", "#cbd0f5", "#6269ac"),
    "grok": ("#f5f7fa", "#cbd4e0", "#53627a"),
    "cartesia": ("#f0faec", "#c9dfb7", "#64833e"),
    "compute": ("#eff7ff", "#b9d5f0", "#3578b7"),
    "memory": ("#eef9fb", "#b7dce5", "#387c91"),
    "history": ("#fff9ec", "#e8d6aa", "#a38136"),
    "artifact": ("#f7f4f0", "#d9cec1", "#7b6a55"),
    "source": ("#f0f8f6", "#b9d9cf", "#3f7d6d"),
}
# key, x, y, width, height, logo, title, role icon, palette, detail lines
NODES = [
    ("auth", 1240, 150, 320, 155, "auth0.svg", "Auth0", "LockKeyhole", "identity", ["Authentication"]),
    ("livekit", 150, 400, 380, 180, "livekit.svg", "LiveKit", "AudioLines", "media", ["Audio rooms"]),
    ("operators", 750, 380, 500, 220, "vercel.svg", "Vercel", "UsersRound", "client", ["Operator browsers", "Next.js + React"]),
    ("observer", 1475, 400, 450, 180, "vercel.svg", "Vercel", "Monitor", "client", ["Read-only display"]),
    ("voice", 95, 715, 490, 220, "digitalocean.svg", "DigitalOcean", "Languages", "media", ["Translation worker", "Python + LiveKit"]),
    ("convex", 1175, 690, 750, 250, "convex.svg", "Convex", "Database", "core", ["Shared state + database", "Server functions + jobs"]),
    ("stt", 45, 1065, 300, 205, "grok.png", "Grok", "Mic", "grok", ["Speech recognition", "Russian speech"]),
    ("translation", 380, 1065, 300, 205, "claude.svg", "Claude", "Languages", "claude", ["Translation"]),
    ("tts", 715, 1065, 365, 205, "cartesia.svg", "Cartesia", "AudioWaveform", "cartesia", ["English speech", "Mandarin speech"]),
    ("analyst", 45, 1380, 440, 205, "claude.svg", "Claude", "BrainCircuit", "claude", ["Incident Analyst", "Operator Advocates"]),
    ("host", 535, 1380, 440, 205, "gemini.png", "Gemini", "MessagesSquare", "gemini", ["Coordination Host"]),
    ("check", 1025, 1380, 440, 205, "grok.png", "Grok", "ShieldCheck", "grok", ["Rationale check"]),
    ("orbit", 1515, 1380, 440, 220, "digitalocean.svg", "DigitalOcean", "Orbit", "compute", ["Python orbital API", "FastAPI + SGP4"]),
    ("memory", 45, 1745, 440, 205, "backboard.png", "Backboard", "BookOpen", "memory", ["Company memory"]),
    ("history", 535, 1745, 440, 205, "tigerdata.svg", "Tiger Data", "ChartNoAxesCombined", "history", ["Observation history"]),
    ("schedule", 1025, 1745, 440, 205, "factory.svg", "Factory", "CalendarCheck", "artifact", ["Schedule artifacts", "Planned DigitalOcean worker"]),
    ("data", 1515, 1745, 440, 205, "celestrak.png", "CelesTrak", "Globe2", "source", ["Pinned orbital data"]),
]


def image_data(filename: str, color: str | None = None) -> str:
    data = (BASE / "icons" / filename).read_bytes()
    if color:
        data = data.replace(b"#64748b", color.encode())
    mime = "image/svg+xml" if filename.endswith(".svg") else "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def text(x: float, y: float, label: str, css: str = "label", anchor: str = "middle") -> str:
    return f'<text x="{x}" y="{y}" class="{css}" text-anchor="{anchor}">{escape(label)}</text>'


def connector(path: str, *, start: bool = False, end: bool = True, color: str = "default") -> str:
    a = f' marker-start="url(#arrow-{color})"' if start else ""
    b = f' marker-end="url(#arrow-{color})"' if end else ""
    return f'<path class="edge {color}" d="{path}"{a}{b}/>'


def node(spec: tuple) -> str:
    key, x, y, w, h, logo, title, role, palette, details = spec
    fill, stroke, accent = PALETTES[palette]
    core, compact = key == "convex", key == "auth"
    badge = 110 if core else (64 if compact else 80)
    badge_x, badge_y = x + (34 if core else 26), y + 24
    cx, cy = badge_x + badge / 2, badge_y + badge / 2
    brand_size = 55 if core else (30 if compact else 33)
    brand_x = badge_x + badge + (26 if core else 18)
    brand_y = y + (96 if core else (68 if compact else 77))
    # Vendor favicon artwork retains its original background, clipped only at the corners.
    full_badge = logo in {"grok.png", "factory.svg", "cartesia.svg"}
    logo_size = badge if full_badge else badge * 0.66
    logo_x, logo_y = cx - logo_size / 2, cy - logo_size / 2
    first_line = y + (177 if core else (124 if compact else 145))
    detail_size = 28 if core else (22 if compact else 24)
    line_gap = 38 if core else 35
    icon_size = 30 if core else 25
    detail_x = x + (79 if core else 65)
    role_x = x + (35 if core else 27)
    parts = [f'<g id="{key}" class="node" data-label="{escape(title)}">']
    parts.append(f'<rect class="card" x="{x}" y="{y}" width="{w}" height="{h}" rx="22" fill="{fill}" stroke="{stroke}" stroke-width="{2.5 if core else 1.8}"/>')
    parts.append(f'<path d="M{x + w - 77} {y + 30} H{x + w - 29}" stroke="{accent}" stroke-width="4" stroke-linecap="round" opacity=".65"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{badge/2}" fill="white"/>')
    parts.append(f'<clipPath id="badge-{key}"><circle cx="{cx}" cy="{cy}" r="{badge/2}"/></clipPath>')
    parts.append(f'<image class="brand-logo" x="{logo_x}" y="{logo_y}" width="{logo_size}" height="{logo_size}" href="{image_data(logo)}" clip-path="url(#badge-{key})"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{badge/2}" fill="none" stroke="{stroke}" stroke-width="1.4"/>')
    parts.append(f'<text x="{brand_x}" y="{brand_y}" class="brand" font-size="{brand_size}">{escape(title)}</text>')
    parts.append(f'<image class="role-icon" x="{role_x}" y="{first_line - icon_size + 4}" width="{icon_size}" height="{icon_size}" href="{image_data(f"roles/{role}.svg", accent)}"/>')
    for i, line in enumerate(details):
        size = 21 if key == "schedule" and i == 1 else detail_size
        parts.append(f'<text x="{detail_x}" y="{first_line + i * line_gap}" class="detail" font-size="{size}">{escape(line)}</text>')
    parts.append("</g>")
    return "\n".join(parts)


parts = [f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="title desc">
<title id="title">OrbitCall system architecture</title>
<desc id="desc">A layered architecture. Auth0 authenticates Vercel operator browsers and the read-only display. Convex is the central application database and job authority. LiveKit audio connects to a DigitalOcean translation worker using Grok recognition and Russian speech, Claude translation, and Cartesia English and Mandarin speech. Convex calls Claude, Gemini and Grok agents, a DigitalOcean orbital API, Backboard memory and Tiger Data history. A Factory schedule-artifact worker is planned. CelesTrak supplies pinned OMM to the orbital API.</desc>
<defs>
  <style>
    text {{ font-family: Arial, Helvetica, sans-serif; fill: #19283f; }}
    .brand {{ font-weight: 700; letter-spacing: -.6px; }}
    .detail {{ fill: #42546b; }}
    .label {{ font-size: 23px; fill: #5c6d83; paint-order: stroke; stroke: white; stroke-width: 12px; stroke-linejoin: round; }}
    .layer {{ font-size: 18px; font-weight: 700; letter-spacing: 2.5px; fill: #8897aa; }}
    .edge {{ fill: none; stroke: #8291a5; stroke-width: 2.3; stroke-linejoin: round; stroke-linecap: round; }}
    .edge.media {{ stroke: #5c998d; }}
    .edge.core {{ stroke: #9682b9; }}
  </style>
''']
for name, color in [("default", "#8291a5"), ("media", "#5c998d"), ("core", "#9682b9")]:
    parts.append(f'<marker id="arrow-{name}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0 L8 4 L0 8 Z" fill="{color}"/></marker>')
parts += ['</defs>', '<rect width="100%" height="100%" fill="white"/>']
parts += [text(1000, 65, "OrbitCall", "page-title"), text(1000, 105, "System architecture", "page-subtitle")]
# Use headings in open space, without frames around a layer.
parts += [text(45, 328, "01  ACCESS & CLIENTS", "layer", "start"), text(45, 653, "02  STATE & VOICE", "layer", "start"), text(45, 961, "03  SPEECH SERVICES", "layer", "start"), text(45, 1297, "04  AGENTS & ORBITAL COMPUTATION", "layer", "start"), text(45, 1635, "05  MEMORY, HISTORY & ARTIFACTS", "layer", "start")]

# Authentication and the two browser roles.
parts += [connector("M1400 305 V342 H1000 V380"), connector("M1400 342 H1700 V400")]
parts += [text(1162, 328, "Authenticate"), text(1610, 328, "Authenticate")]
parts += [connector("M530 490 H750", start=True, color="media"), text(640, 463, "Live audio")]
parts += [connector("M1000 600 V640 H1330 V690", start=True, color="core"), connector("M1700 580 V690", start=True, color="core")]
parts += [text(1436, 625, "Live state"), text(1728, 640, "Live state", anchor="start")]

# Live audio and checked text. Only the worker publishes final voice messages to Convex.
parts += [connector("M340 580 V715", start=True, color="media"), text(365, 620, "Audio streams", anchor="start")]
parts += [connector("M585 815 H1175", color="media"), text(880, 788, "Checked text + metadata")]
parts += [connector("M340 935 V985", start=True, end=False, color="media"), connector("M195 985 H897.5", end=False, color="media")]
for cx in [195, 530, 897.5]:
    parts.append(connector(f"M{cx} 985 V1065", color="media"))

# Shared service bus, then a branch through the center gap to supporting services.
parts += [connector("M1550 940 V1315", start=True, end=False, color="core"), text(1577, 1155, "Backend service calls", anchor="start")]
parts += [connector("M265 1315 H1735", end=False, color="core")]
for cx in [265, 755, 1245, 1735]:
    parts.append(connector(f"M{cx} 1315 V1380", color="core"))
parts += [connector("M1000 1315 V1660", end=False, color="core"), connector("M265 1660 H1245", end=False, color="core")]
for cx in [265, 755, 1245]:
    parts.append(connector(f"M{cx} 1660 V1745", color="core"))
parts += [connector("M1735 1745 V1600"), text(1765, 1674, "Pinned OMM", anchor="start")]

parts += [node(n) for n in NODES]
parts += ['<style>.page-title { font-size: 48px; font-weight: 700; letter-spacing: -1.4px; }.page-subtitle { font-size: 25px; fill: #687991; }</style>', '</svg>']
(BASE / "architecture.svg").write_text("\n".join(parts) + "\n")
print(f"Built {BASE / 'architecture.svg'} ({len(NODES)} nodes)")
