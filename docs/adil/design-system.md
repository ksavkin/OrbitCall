# OrbitCall UI design system

Source of truth: [master roadmap v1.1](../master-roadmap.md). It defines the four-screen demo, 2-4 operator rooms, EN/RU/ZH voice, sponsor roles, and DigitalOcean deployment. Claude runs analysis/advocates, Gemini runs the Coordination Host, and Grok runs independent checking and selected audio tasks. Existing implementation notes below are not completion claims.

The target agent UI identifies Gemini on the Host, Claude on the Analyst/Advocates, and Grok on the checker. Provider/model labels and successful-call states come from recorded backend runs. Simulated traces keep their development label. Existing prototype graphics do not establish a completed integration.


Rules for anyone (person or agent) who builds or changes the OrbitCall frontend. They come from the code in `web/` and from Adil's review comments during the build. Adil reads every screen at the pixel level. A screen that "works" but has a stray line, a popping model or a clipped tooltip is not done.

Read this file before changing the UI. Product behavior follows [the accepted user flow](../user-flow.md) and [backend specification](../specification.md). This document describes visual conventions and distinguishes the current prototype from target behavior.

## Current product layout amendment

The user-approved target is [My Fleet + My Incidents + globe](../user-flow.md). Always list every assigned spacecraft, including zero-incident objects, with position time and orbit freshness. Selecting one filters incidents and focuses the globe; Run Scan still covers the full fleet. Prioritize severity, then closest approach, and keep missing/stale evidence in a separate visible review section. Explain TCA as "Time until closest approach". Display up to four computed options, selection separately from Approve, and unilateral debris without a fictional second approval. These are target requirements, not a claim that the prototype already implements them.

## 1. Principles

1. **Real data or clearly labeled synthetic data.** No invented numbers, no decorative fake charts. If a value is synthetic (dev simulator), the UI says so with an orange `SYN` / `Synthetic` label. If a price or source is not verified, show `—` and say why in a tooltip.
2. **No "AI slop".** No generic glowing blobs, spiral clip-art, gradients for decoration, or icons that only look busy. Every mark on screen means something. When in doubt, look at how a real ops tool (Esri, Vercel dashboard, flight trackers) draws the same thing.
3. **Copy the references closely.** Adil gives reference screenshots (Vercel-style dark dashboard, light pill components, agent graph and agent tree cards). Match their layout, spacing and hierarchy 1:1, then adapt the colors to our dark theme.
4. **Small and calm.** The UI is built for a laptop. Base font size is 12px. Panels are compact, the globe is the hero. Nothing should feel loud or oversized.
5. **Every state is designed.** Loading, empty, error, running, done, failed, backend not connected. Never ship a blank panel.
6. **Physics is code, models only talk.** Any number shown in agent text must come from a computed value (SGP4, the rocket equation), never typed by hand. See `web/src/lib/ops/scenarios.ts` for the pattern.

## 2. Tokens

Defined in `web/src/app/globals.css` (`:root` and `@theme inline`). Use the Tailwind names (`text-muted`, `bg-red`) or the CSS variables. Do not add new hex colors inside components unless it is a data color listed below.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#050506` | Page background |
| `--panel` | `rgba(16,17,19,0.58)` | Glass panel fill |
| `--fg` | `#ededee` | Primary text |
| `--fg-2` | `#b4b8be` | Secondary text, values |
| `--muted` | `#80858d` | Labels |
| `--faint` | `#52565c` | Tertiary info, separators |
| `--green` | `#3ddc97` | OK, approved, live, verified |
| `--red` | `#ff5a4f` | Red risk, error, debris |
| `--orange` | `#ff9f40` | Needs a human, warnings, dev mode |
| `--amber` | `#f5c451` | Yellow risk, sunlit, proposal ready |
| `--blue` | `#4f8cff` | Running, calls, selection accents |

Data colors (fixed meaning, reuse them):

- Satellite categories: `CATEGORY_META` in `web/src/lib/theme.ts`.
- Countries: `OWNER_COLORS` in the same file (top 11 owners, grey for the rest).
- Agent graph edges: call `#4f8cff`, answer `#3ddc97`, needs you `#ff9f40` (dashed, marching), failed `#ff5a4f`. Defined as `EDGE` in `web/src/components/ops/meta.ts`.
- Agent hues for trace rows: `AGENT_HUE` in the same file.
- Event status labels and colors: `STATUS_META` in the same file. Do not invent new status strings. They come from `docs/functionality.md` §3.

Typography:

- Geist Sans for text, Geist Mono (class `mono`) for every number, ID, time, URL and log line. Add `tnum` to numbers that change so digits don't jump.
- Sizes in use: 9 to 10.5px for labels and meta, 11 to 12px for body, 13 to 13.5px for panel titles, 19 to 26px only for one hero number per panel.
- Section labels use `.eyebrow` (9.5px, uppercase, 0.14em tracking, muted).

Radii: panels 14px, cards inside panels 9 to 11px, buttons 9px, pills full.

## 3. Surfaces

- **Glass** (`.glass`): blur 22px, saturate 170%, inner rim light, specular top-left edge (`::before`) and a cursor spotlight (`::after`, driven by `--mx`/`--my` in `OrbitApp.tsx`). Use it for every floating panel. `.glass-strong` for popovers and overlays that need more contrast.
- Never write `rgba(var(--x), a)` in `globals.css`. The CSS pipeline drops the edit without an error and keeps serving the last good build. Use literal colors or `color-mix()`.
- `.glass` sets no `position`. Add `relative` or `absolute` yourself. (A past bug: `.glass` had `position: relative` and broke the footer.)
- Cards inside a panel: `bg-white/[0.025]` to `[0.035]` with `shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]`. Dividers: `bg-white/[0.06]` or `border-white/[0.05]`.
- Panels enter with `opacity 0, x ±16, blur 8px` to normal in 0.32s, ease `[0.22, 1, 0.36, 1]`. Exit mirrors it.

## 4. Components

Reuse these before writing new ones.

| Component | Where | Notes |
|---|---|---|
| `.btn`, `.btn-primary`, `.btn-ghost-line`, `.icon-btn` | `globals.css` | Press scales to 0.95 / 0.9 with a spring. Hover lightens the background. Every clickable gets a hover and a press state. |
| Segmented control | `seg-pill` + `motion.span layoutId` | Spring `stiffness 500, damping 38`. Each control needs its own `layoutId`. |
| `Tooltip` | `components/ui/Tooltip.tsx` | Portal, fixed position, clamped to the viewport. Use it for every icon button and every number that needs context. Add `hint` for the keyboard shortcut. |
| `Chip` | `components/ui/Chip.tsx` | One color makes text, 10% fill and 20% rim. Use for status. |
| `.kbd` | `globals.css` | Shortcut hint inside buttons and tooltips. |
| `.pulse-dot` | `globals.css` | Live / running indicator. |
| `Flag`, `OwnerBadge` | `components/ui/OwnerBadge.tsx` | Real flags from `public/flags`. Show the country name next to the flag in detail views. |
| Metric grid, `Section`, `Row` | `SatellitePanel.tsx` | Pattern for key-value detail panels. Rows wrap long values, they never overflow. |
| `useNow(ms)` | `lib/useNow.ts` | Ticking clock without hydration errors. Never call `Date.now()` during render. |

Panel anatomy: eyebrow label, then one big number with a small unit, then a short status line, then the content. See `ConjunctionQueue.tsx` and `CatalogPanel.tsx`.

## 5. Motion and micro-interactions

- Durations: 0.18 to 0.25s for small state changes, 0.3 to 0.35s for panels, 1.4 to 2.2s for camera flights.
- Easing: `[0.22, 1, 0.36, 1]` (`--ease-out`) for most things, `--ease-spring` for presses and badges.
- Lists animate rows in (`y -8` to 0) and use `layout="position"` so reordering slides.
- Expanding details use height `0` to `auto` with opacity.
- Running work must look alive: spinning conic ring on graph nodes (`.node-ring`), light sweep on queue rows (`.agent-sheen`), streamed text with a blinking caret (`.caret`), pulses traveling along graph edges.
- Respect `prefers-reduced-motion` (already global in `globals.css`).

## 6. Sound

Synthesized in `web/src/lib/sound.ts`, quiet by design, mutable with the navbar button or `M`. The preference is saved.

| Sound | When |
|---|---|
| `hover` | Hovering a control or satellite (rate limited) |
| `click` | Pressing a control |
| `toggle(on)` | Switches |
| `select` | Selecting a satellite or an event |
| `whoosh` | Camera flights, expanding a view, starting a scenario |
| `alert` | An event turns red |
| `chime` | Proposal ready, maneuver confirmed, approve |

Don't add sounds for things that happen without the user doing anything, except `alert` and `chime`.

## 7. Globe and 3D rules

These come from specific review comments. Each one was a real bug once.

- Satellites are small real 3D models that fade to glow dots when far. Click selects, hover shows the card, Follow flies to the model.
- The selected model is the PBR hero with real reflections (cube camera of the actual scene). Starlink uses its own model with the SpaceX wordmark.
- **No reticle box on a followed model.** The reticle is for tiny objects only.
- **Follow never passes through the Earth.** Camera flights interpolate around Earth's center.
- **No pop-in.** The model grows during the zoom (`animateFocus`), it never appears at full size.
- **Rotation around a followed satellite stays fast** (rotate speed 0.75). Slow orbiting makes inspection impossible.
- **Selecting from search centers the satellite** on screen (tracking mode).
- **One trajectory only.** When a satellite is selected or followed, no hover orbits or old paths stay on screen. The path is centered on the satellite (half a revolution behind, half ahead) so its ends don't look like a stray line.
- **Trajectories and ground track must be clearly visible** on every imagery. The ground track stays visible while following.
- **Night view looks like night.** City lights, no coastline outlines. Terrain view has no blocky coast edges.
- **Tile imagery must look sharp up close** (Esri World Imagery up to zoom 18).
- **Heatmaps are smooth thermal maps** with isolines. No dot matrix, no flat clipped plateaus, no visible grid squares.
- Every data layer can be turned on and off (Layers button). Weather comes from real feeds and shows its age.
- Conjunctions: both orbits drawn bright at the TCA point and fading away from it, a diamond marker at TCA, a label with ID, miss and countdown. Preview TCA jumps the clock 70 s before TCA so both objects visibly converge. Leaving the screen returns the clock to live.

## 8. Layout map

Viewport rules: navbar row top 10px, footer 36px at the bottom, panels start at `top-[58px]`.

| Screen | Left | Center | Right |
|---|---|---|---|
| Orbit | Catalog panel + Live weather (244px) | Globe, storm labels | Satellite panel (296px) when selected |
| Conjunctions | Conjunction queue (300px) | Globe with event orbits and markers, scenario bar (dev only) | Agents panel (372px), map controls move left of it |

Bottom left: view switcher. Bottom right: map controls. Overlays (expanded agents) start below the navbar so the navbar stays usable.

## 9. Dev mode

- The `Dev` switch in the navbar (shortcut `D`) turns on the simulator in `web/src/lib/ops/engine.ts`. It uses the simulator view model in `web/src/lib/ops/types.ts`. The backend contract differs and requires an explicit adapter; see `docs/specification.md`. Dev on retains the current TLE catalog and synthetic scenarios.
- Dev off is real mode and loads the pinned OMM index named by Convex. The loader and direct OMM worker propagation are implemented. With no valid snapshot, show the explicit waiting/error state and no TLE or synthetic fallback. A configured connection alone does not prove successful loading. Both modes live in `main` and `adil`.
- Private policy values and internal model context never appear in shared traces or explanations. Any prototype traces containing synthetic private values are simulator-only and must not be copied into live payloads.
- Synthetic objects are built around real catalog satellites so the geometry on the globe is true (`web/src/lib/ops/encounter.ts`). Their names end in `(SYN)`.
- Agent cost uses Anthropic list prices. Grok cost shows `—` until prices are confirmed.

## 10. Checklist before you call a screen done

- [ ] Compared side by side with the reference screenshot.
- [ ] Hover, press, focus and disabled states on every control.
- [ ] Loading, empty, error and backend-off states.
- [ ] No text overflow at 1280px wide. Tooltips stay inside the viewport.
- [ ] Numbers use `mono tnum`, units are muted and smaller.
- [ ] No console errors, `npx tsc --noEmit` and `npx eslint src` pass.
- [ ] Checked in the browser with a screenshot, not only in code. Look for stray lines, popping elements and labels on top of lines.
- [ ] Anything synthetic or unverified is labeled.

## 11. Feedback log

Adil's review comments that shaped these rules, in order (all from the first build session, 2026-10-23 to 2026-10-24). Add new ones at the bottom with the date.

| # | Comment (paraphrased) | Rule |
|---|---|---|
| 1 | Follow the references 1:1, Grok / SpaceX dark style, real liquid glass, micro-interactions, sounds that can be turned off | §1.3, §3, §5, §6 |
| 2 | Real live satellites only, no AI slop | §1.1, §1.2 |
| 3 | Smaller fonts, zoomed out, comfortable on a laptop | §1.4 |
| 4 | Each satellite a small real 3D model, clickable, followable, hover info from a real API | §7 |
| 5 | Weird box on the satellite when following | §7 reticle |
| 6 | Globe should look like Google Maps up close | §7 imagery |
| 7 | Satellite model looks ugly, want real mirrors and reflections like the reference renders | §7 hero |
| 8 | Follow zooms inside the globe, model pops in before the zoom | §7 flights, pop-in |
| 9 | Trajectory disappears or other trajectories show underneath | §7 one trajectory |
| 10 | Rotation around a followed satellite is too slow | §7 rotation |
| 11 | Search selection is not centered | §7 search |
| 12 | Show real country flags and names, filter and color by country, select all / none | §4 flags |
| 13 | Tooltip overflows the screen | §4 Tooltip |
| 14 | Night and terrain views have weird outlines | §7 night |
| 15 | Storm spiral icon looks like AI slop | §1.2 |
| 16 | Congestion dots should be a thermal map, then: no squares in the middle | §7 heatmaps |
| 17 | Ground track disappears while following | §7 ground track |
| 18 | Dev switch with synthetic scenarios, agents shown working with real-looking traces, cost and latency | §9 |
