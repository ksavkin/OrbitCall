import { AnalystError } from "./analyst";

export interface MemoryItemDraft { companyId: string; demoRunId: string; text: string;
  sourceEventId: string; sourceMessageIds: string[] }

const MAX_TEXT = 280, MAX_SOURCE_MESSAGES = 20;
// Source event IDs reach shareable text, so they must be opaque identifiers, never prose.
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
const APPROVAL = /approv|authori[sz]|\bsign(?:ed|s|ing)?[\s-]*off\b|signoff|veto|consent|agree|\bgreen[\s-]*light|\bgo[\s-]*ahead\b|\bcleared to\b/i;
// Fuel masses and protected window times are private policy values (§6); memory keeps the preference, not the number.
const PRIVATE_VALUES = [
  /\d\s*(?:kg|kilograms?|g|grams?)\b/i,
  /\b(?:fuel|reserve|propellant)\b[^.;]{0,24}\d/i,
  /\d{4}-\d{2}-\d{2}/,
  /\d:\d{2}/,
  /\b\d{3,4}\s*(?:z|utc|gmt)\b/i,
  /\b\d{1,2}\s*(?:am|pm)\b/i,
];

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const text = (value: unknown) => typeof value === "string" ? value : "";

function sourcesValid(sourceEventId: unknown, sourceMessageIds: unknown) {
  return typeof sourceEventId === "string" && SOURCE_ID.test(sourceEventId) && Array.isArray(sourceMessageIds) &&
    sourceMessageIds.length >= 1 && sourceMessageIds.length <= MAX_SOURCE_MESSAGES &&
    sourceMessageIds.every(id => typeof id === "string" && SOURCE_ID.test(id)) && new Set(sourceMessageIds).size === sourceMessageIds.length;
}

function textProblem(value: unknown): AnalystError | null {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    return new AnalystError("INVALID_OUTPUT", `Memory text must be a single line of 1 to ${MAX_TEXT} characters.`);
  }
  if (APPROVAL.test(value)) return new AnalystError("CONSTRAINT_CHECK_FAILED", "Memory cannot record or carry over an approval.");
  if (PRIVATE_VALUES.some(pattern => pattern.test(value))) {
    return new AnalystError("CONSTRAINT_CHECK_FAILED", "Memory cannot store raw private values such as fuel mass or protected window times.");
  }
  return null;
}

export function checkMemoryItem(item: MemoryItemDraft): void {
  if (!nonEmpty(item.companyId) || !nonEmpty(item.demoRunId)) {
    throw new AnalystError("INVALID_OUTPUT", "A memory item needs its company and demo run.");
  }
  if (!sourcesValid(item.sourceEventId, item.sourceMessageIds)) {
    throw new AnalystError("INVALID_OUTPUT", "A memory item needs its source event and at least one distinct source message ID.");
  }
  const problem = textProblem(item.text);
  if (problem) throw problem;
}

export function buildMemoryItem(input: { companyId: string; demoRunId: string; preference: string;
  sourceEventId: string; sourceMessageIds: string[] }): MemoryItemDraft {
  const draft: MemoryItemDraft = {
    companyId: text(input.companyId).trim(), demoRunId: text(input.demoRunId).trim(),
    text: text(input.preference).replace(/\s+/g, " ").trim(),
    sourceEventId: text(input.sourceEventId).trim(),
    sourceMessageIds: [...new Set((Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : []).map(id => text(id).trim()))],
  };
  checkMemoryItem(draft);
  return draft;
}
