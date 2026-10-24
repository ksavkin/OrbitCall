import { json2satrec, twoline2satrec, type SatRec } from "satellite.js";

/** One OMM record as CelesTrak serves it (FORMAT=json). */
export type OmmRecord = Parameters<typeof json2satrec>[0];

/**
 * An element set as delivered: TLE lines in the Dev catalog, an OMM record in real mode.
 * OMM is propagated as OMM, never converted back to TLE (DATA-6).
 */
export type Elements = { format: "tle"; line1: string; line2: string } | { format: "omm"; record: OmmRecord };

export function satrecOf(e: Elements): SatRec {
  return e.format === "tle" ? twoline2satrec(e.line1, e.line2) : json2satrec(e.record);
}

/** Clipboard text: the TLE with its name line, or the OMM record as JSON. */
export function elementsText(name: string, e: Elements): string {
  return e.format === "tle" ? `${name}\n${e.line1}\n${e.line2}` : JSON.stringify(e.record, null, 2);
}
