import type { Category } from "@/lib/catalog/types";

export const CATEGORY_META: Record<Category, { label: string; color: string; hint: string }> = {
  station: { label: "Space stations", color: "#ffffff", hint: "Crewed stations, CelesTrak stations group" },
  starlink: { label: "Starlink", color: "#a7b1bf", hint: "SpaceX broadband shell" },
  oneweb: { label: "OneWeb", color: "#5ad1e6", hint: "Eutelsat OneWeb broadband" },
  gnss: { label: "Navigation", color: "#f5c451", hint: "GPS, GLONASS, Galileo, BeiDou, QZSS, IRNSS" },
  geo: { label: "Geosynchronous", color: "#a594ff", hint: "~1 revolution per sidereal day" },
  other: { label: "Other payloads", color: "#4f8cff", hint: "All other active payloads" },
  debris: { label: "Debris", color: "#ff5a4f", hint: "Cosmos 2251, Iridium 33, Fengyun-1C fragments" },
};

export const STATUS = {
  green: "#3ddc97",
  red: "#ff5a4f",
  orange: "#ff9f40",
  amber: "#f5c451",
  blue: "#4f8cff",
};

/** Distinct colors for the largest operators by object count; everyone else is grey. */
export const OWNER_COLORS: Record<string, string> = {
  US: "#4f8cff",
  PRC: "#ff5a4f",
  CIS: "#f5c451",
  UK: "#3ddc97",
  JPN: "#ff7eb6",
  IT: "#b5e655",
  IND: "#ff9f40",
  FR: "#a594ff",
  GER: "#5ad1e6",
  ESA: "#e6e8eb",
  SKOR: "#ffc9a3",
};
export const OTHER_OWNER_COLOR = "#6b7280";
export const ownerColor = (code: string) => OWNER_COLORS[code] ?? OTHER_OWNER_COLOR;
