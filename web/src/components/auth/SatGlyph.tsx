import type { SatKind } from "./session";

// Small 2D drawings of a spacecraft by what it does, for the fleet list. Line art in the app's style: thin
// white strokes on dark, one accent per kind, no gradients.

const ACCENT: Record<SatKind, string> = { imaging: "#7fb2ff", rf: "#ffb340", weather: "#5fd3c6", cubesat: "#c792ff" };
export const KIND_LABEL: Record<SatKind, string> = { imaging: "Earth imaging", rf: "RF sensing", weather: "Weather", cubesat: "CubeSat" };

export function SatGlyph({ kind, size = 40 }: { kind: SatKind; size?: number }) {
  const a = ACCENT[kind];
  const line = { stroke: "rgba(255,255,255,0.85)", strokeWidth: 1.3, fill: "none", strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  const panel = { stroke: a, strokeWidth: 1.1, fill: `${a}26` };
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label={KIND_LABEL[kind]} role="img">
      {kind === "imaging" && (
        <>
          <rect x="3" y="14" width="10" height="12" rx="1" {...panel} />
          <rect x="27" y="14" width="10" height="12" rx="1" {...panel} />
          <path d="M8 14v12M32 14v12" stroke={a} strokeWidth="0.8" />
          <path d="M13 20h3M24 20h3" {...line} />
          <rect x="16" y="13" width="8" height="14" rx="1.5" {...line} />
          <circle cx="20" cy="30.5" r="2.6" {...line} />
          <circle cx="20" cy="30.5" r="1" fill={a} />
        </>
      )}
      {kind === "rf" && (
        <>
          <rect x="14" y="14" width="12" height="12" rx="1.5" {...line} />
          <path d="M20 14V5M14 26l-7 7M26 26l7 7" {...line} />
          <circle cx="20" cy="4.5" r="1.4" fill={a} />
          <circle cx="6.5" cy="33.5" r="1.4" fill={a} />
          <circle cx="33.5" cy="33.5" r="1.4" fill={a} />
          <path d="M8 12a14 14 0 0 1 4-5M32 12a14 14 0 0 0-4-5" stroke={a} strokeWidth="1" fill="none" strokeLinecap="round" />
          <rect x="17" y="17" width="6" height="6" rx="1" {...panel} />
        </>
      )}
      {kind === "weather" && (
        <>
          <rect x="22" y="15" width="14" height="10" rx="1" {...panel} />
          <path d="M26.5 15v10M31 15v10" stroke={a} strokeWidth="0.8" />
          <path d="M19 20h3" {...line} />
          <rect x="9" y="13" width="10" height="14" rx="1.5" {...line} />
          <path d="M6 31a8 4 0 0 1 16 0" {...line} />
          <path d="M14 27v4" {...line} />
          <circle cx="14" cy="31" r="1" fill={a} />
        </>
      )}
      {kind === "cubesat" && (
        <>
          <path d="M14 15l6-3 6 3v10l-6 3-6-3z" {...line} />
          <path d="M14 15l6 3 6-3M20 18v10" {...line} />
          <path d="M14 17l-9-3v9l9 3" {...panel} />
          <path d="M26 17l9-3v9l-9 3" {...panel} />
          <path d="M20 12V6" {...line} />
          <circle cx="20" cy="5.5" r="1.2" fill={a} />
        </>
      )}
    </svg>
  );
}
