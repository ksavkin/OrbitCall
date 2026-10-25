import type { BackendError } from "./errors";
import type { EventId } from "./types";

/**
 * "Run agents on this case" in real mode (wiring map §2): rooms.startWorkflow, keep the room for the case, watch the
 * agents on Orbit. Resolves null on success, or the backend error to show. Placeholder until its task lands.
 */
export async function runAgentsOn(eventId: EventId): Promise<BackendError | null> {
  return { code: "NOT_WIRED", message: `Starting agents on ${eventId} is not wired yet.` };
}
