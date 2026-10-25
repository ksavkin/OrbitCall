import { ConvexError } from "convex/values";

/** A backend error: `message` is written for end users, so show it unless the wiring map says otherwise. */
export type BackendError = { code: string; message: string };

/** One place to read a backend error code from a rejected mutation or action. */
export function backendError(e: unknown): BackendError {
  if (e instanceof ConvexError && e.data && typeof e.data === "object" && "code" in e.data) return e.data as BackendError;
  return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}
