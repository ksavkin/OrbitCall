// Formatting for ops numbers. Shared by the scenario texts and the UI so a
// number reads the same in a rationale and on a card.

export function fmtPc(pc: number) {
  if (pc <= 0) return "0";
  const e = Math.floor(Math.log10(pc));
  const m = pc / 10 ** e;
  return `${m.toFixed(1)}e${e}`;
}

export function fmtMiss(m: number) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

export function fmtCountdown(ms: number) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p = (x: number) => String(x).padStart(2, "0");
  const body = d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}:${p(s)}`;
  return `${neg ? "T+" : "T−"}${body}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtWhen(t: number) {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function fmtUsd(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
