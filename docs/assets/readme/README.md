# README visual assets

The root README uses a self-contained architecture SVG, its PNG export, and local technology logos. The layout and text are authored in Python so labels, spacing, and connections remain editable. Brand artwork comes from the sources recorded in [icon-sources.json](icon-sources.json).

## Rebuild the diagram

From the repository root:

```sh
python3 docs/assets/readme/build-architecture.py
node docs/assets/readme/build-readme-assets.mjs
```

The Node.js script uses the frontend's Sharp dependency to export `architecture.svg` as `architecture.png` at its native 2000 by 1995 size. Install the frontend dependencies before running it. Inspect the export in a browser after rebuilding.

Keep the PNG and SVG together. The README embeds the PNG for consistent GitHub rendering and links to the editable SVG. All logo and role images in the SVG are embedded as data URLs, so it makes no network requests.

## Layout

- Five open layers separate clients, application state, speech, computation, and supporting services.
- Convex is the largest card because it owns shared application state and coordinates backend work.
- Each service has its original brand artwork in a circular badge and a separate role icon.
- Color identifies a service family. Orthogonal connections show the communication paths.
- The Factory card identifies the Node.js and Droid schedule worker.

Check text padding, line spacing, connector crossings, and logo rendering after any change. Keep labels out of connector paths and leave enough room for both Mandarin and English speech labels.

## Sources and attribution

- Monochrome technology marks come from [Simple Icons 16.35.0](https://github.com/simple-icons/simple-icons/tree/16.35.0), distributed under [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/16.35.0/LICENSE.md). The manifest records the package and each icon path.
- Claude, DigitalOcean, Convex, Factory, Cartesia, Grok, Gemini, Backboard, CelesTrak, and Tiger Data artwork comes from their vendor-hosted assets. Exact download URLs are in the manifest. Claude uses its original orange symbol, DigitalOcean uses its official blue icon, and Convex uses the original multicolor symbol from its brand kit. These files retain their vendor colors. Gemini uses the Gemini sparkle, and Factory and Cartesia use their own symbols.
- Role icons come from the repository's installed [Lucide](https://lucide.dev/) package. Its ISC and applicable MIT notices are included in [icons/roles/LICENSE.txt](icons/roles/LICENSE.txt). These symbols describe service functions and are separate from company logos.
- Brand names and marks belong to their respective owners. Their inclusion identifies the project's technologies and integrations.

## README presentation assets

Run `node docs/assets/readme/build-readme-assets.mjs` from the repository root after installing the frontend dependencies. It uses the frontend's Sharp package to generate `logos/*.png`, the linked navigation images in `links/`, and the architecture PNG. The circles provide a consistent light surface for original brand artwork on both GitHub themes. Brand paths and colors stay intact.

Color stack icons come from pinned [Devicon source artwork](https://github.com/devicons/devicon). The revision and file URLs are in `icon-sources.json`, with its MIT notice in `icons/DEVICON-LICENSE.txt`. React and NASA use assets from their own websites. These third-party asset licenses do not assign a license to OrbitCall.

The video cover comes from the team's published OrbitCall demo. Its source and video URL are recorded in `link-sources.json`. The navigation badge layout is authored locally and displays links, not build-status or license claims.
