import { useOps } from "@/lib/ops/store";
import { startWorkflowRef } from "./api";
import { backendError, type BackendError } from "./errors";
import { openCase, setCaseRoom } from "./live";
import { mutate } from "./run";
import type { EventId, RoomId } from "./types";

// The case whose agents this screen started, watched on Orbit until its first plans arrive. OpsSync then moves it
// to the Decision Center, once. Other screens are never moved: their operators get an inbox notice (wiring map §2.2).
let watching: EventId | null = null;

/** The case this screen started and is watching for its first plans, if any. */
export function watchedCase(): EventId | null {
  return watching;
}

/** Stop watching: the plans arrived, or the screen moved on to another case. */
export function stopWatching() {
  watching = null;
}

/**
 * "Run agents on this case" in real mode (wiring map §2): rooms.startWorkflow, keep the room for the case, watch the
 * agents on Orbit. Resolves null once the screen is on the case: started, or opened read-only because it is already
 * resolved. Otherwise resolves the backend error to show; FORBIDDEN means this person cannot start it, so the caller
 * disables Run for that case.
 */
export async function runAgentsOn(eventId: EventId): Promise<BackendError | null> {
  let roomId: RoomId;
  try {
    ({ roomId } = await mutate(startWorkflowRef, { eventId }));
  } catch (e) {
    const error = backendError(e);
    // "This incident is already resolved.": nothing to start, so show the case as it ended
    if (error.code !== "INVALID_STATE") return error;
    openCase(eventId);
    useOps.setState((s) => ({ scan: { ...s.scan, phase: "idle" }, alert: null }));
    return null;
  }
  // set before the switch below: on a re-run of the open case its plans may already be here
  watching = eventId;
  // As runIncident in the simulator: the agents work on Orbit (graph on the right, camera on the case) and OpsSync
  // opens the Decision Center when the first plans arrive. No actAs: the backend says which side this person is.
  useOps.setState((s) => ({
    scan: { ...s.scan, phase: "idle" },
    alert: null,
    resolved: null,
    focusEvent: eventId,
    agentView: "graph",
    incident: eventId,
    incidentView: "collapsed",
    tab: "orbit",
  }));
  // after the switch, so the open case gets its room even where sessionStorage is unavailable
  setCaseRoom(eventId, roomId);
  return null;
}
