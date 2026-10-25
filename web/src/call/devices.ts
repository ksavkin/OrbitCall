// Microphone ids. The pseudo ids the OS exposes for "the current default" are a trap on macOS: Chrome's "default" can
// resolve to a silent built-in mic while the device the user sees labelled works (lesson R18). Resolve the alias to the
// real device behind it (same non-empty groupId) and pin that.

const PSEUDO_IDS = new Set(["default", "communications"]);

export const isPseudoDeviceId = (id: string | null | undefined): boolean => !!id && PSEUDO_IDS.has(id);

/** A pseudo id → the real device with the same groupId; a real id passes through; never guesses across groups. */
export function resolveRealDeviceId(devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind, deviceId: string): string {
  if (!PSEUDO_IDS.has(deviceId)) return deviceId;
  const alias = devices.find((d) => d.deviceId === deviceId && d.kind === kind);
  if (!alias?.groupId) return deviceId;
  const real = devices.find((d) => d.kind === kind && d.groupId === alias.groupId && d.deviceId && !PSEUDO_IDS.has(d.deviceId));
  return real ? real.deviceId : deviceId;
}

/** Devices to offer in a picker: real ids only, labelled (labels appear after the microphone permission). */
export const pickable = (devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind) =>
  devices.filter((d) => d.kind === kind && d.deviceId && !PSEUDO_IDS.has(d.deviceId));
