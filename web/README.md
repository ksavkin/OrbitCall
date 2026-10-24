# OrbitCall web

The ops UI prototype. The current first screen is the live orbit view. The approved target is [My Fleet + My Incidents + globe](../docs/user-flow.md), with four assigned spacecraft per enabled demo account, fleet-versus-catalog Run Scan over 72 hours, severity then closest-approach ordering, and a separate missing/stale-data review section. This target is not implemented yet. Backend integration follows [the specification](../docs/specification.md); simulator types require an adapter. TCA means Time of Closest Approach. Shared candidate selection and individual Approve are separate, with up to four computed candidates and a distinct unilateral debris workflow.

```sh
npm install
npm run dev        # http://localhost:3000
```

## What's on screen

- Every object in the CelesTrak GP `active` group plus three debris clouds (Cosmos 2251, Iridium 33, Fengyun-1C), propagated with SGP4 in a Web Worker (`src/lib/orbit/propagate.worker.ts`). The GPU extrapolates between samples, so motion stays smooth at any time speed.
- Owner, launch date and site, object type and RCS come from CelesTrak SATCAT.
- Five globe views: Realistic (real sun position, night lights, clouds), Imagery, Night, Terrain, Tactical.
- Zooming in streams map tiles (`src/components/globe/tiles.ts`): Esri World Imagery, Esri World Hillshade and NASA GIBS VIIRS Black Marble. Attribution follows the source on screen.
- The selected object gets a detailed PBR model (`hero.ts`). Its reflections come from a cube camera at the satellite's position, so the arrays show the real Earth below.

## Live weather

Toggle in the Layers popover. Clouds show in every view except Tactical.

| Layer | Source | Cadence |
|---|---|---|
| Clouds | EUMETSAT geostationary-ring IR 10.8 µm mosaic (`mumi:worldcloudmap_ir108`) | 3 h |
| Wind | NOAA GFS 0.5° 10 m wind via PacIOOS ERDDAP, sampled every 2° | 3 h |
| Ocean currents | MeteoFrance SMOC via Open-Meteo Marine, 5° ocean points | daily |
| Tropical cyclones | NOAA NHC CurrentStorms + GDACS (other basins) | 30 min |
| Tornadoes (US) | NWS active Tornado Warnings/Watches + SPC reports | 2 min |
| Aurora, Kp | NOAA SWPC OVATION + planetary K-index | 5 min |

Notes: IR can't tell ice from cloud, so clouds fade out poleward of 60–70°. Open-Meteo counts each location as a call, so the currents fetch is paced (~3.5 min cold) and cached 12 h. Every layer falls back to `.cache/weather/`, then `data/weather/`.

## Data

`/api/catalog` (`src/lib/catalog/build.ts`) downloads from CelesTrak at most once every 2 hours, because CelesTrak blocks clients that download a group more often. If the download fails, it serves the copy in `.cache/`, then the committed snapshot in `data/snapshot/`, so the demo works offline. Set `ORBITCALL_OFFLINE=1` to skip the network.

Refresh the snapshot by re-downloading the `.tle` groups and `satcat.csv` listed in `GROUPS` into `data/snapshot/`, then update `fetched_at.txt`.

## Assets

- Earth textures: Solar System Scope (CC BY 4.0, based on NASA imagery including Blue Marble) and three-globe example images (NASA).
- SpaceX wordmark: Wikimedia Commons, public domain, trademark of SpaceX. Shown on SpaceX-operated Starlink models only.

## Keys

`⌘K` search · `1–5` views · `F` follow · `G` ground track · `Space` pause · `R` reset · `A` auto-rotate · `M` mute · `Esc` deselect
