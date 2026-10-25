/** The one LiveKit call currently open in this tab. Close case / resolution must end it so sessions do not pile up. */

type LeaveFn = () => Promise<void>;

let active: LeaveFn | null = null;

/** Register the open call's leave. Returns an unregister that only clears if still this leave. */
export function registerActiveCall(leave: LeaveFn): () => void {
  active = leave;
  return () => {
    if (active === leave) active = null;
  };
}

/** End the open LiveKit session if any (Close case, resolution, host leave). Safe when none. */
export async function endActiveCall(): Promise<void> {
  const leave = active;
  active = null;
  if (!leave) return;
  try {
    await leave();
  } catch {
    /* already gone */
  }
}
