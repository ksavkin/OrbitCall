import type { Priority } from "./model";

// Starting values for the demo accounts' policies, so the screen shows what a filled policy looks like. They are
// plausible for each spacecraft class (masses, propellant and specific impulse of small RF, CubeSat, imaging and
// weather satellites), not real operator data. Windows are placed relative to tomorrow so they stay in the future.

export interface DemoSatellitePolicy {
  minFuelReserveKg: number;
  currentFuelKg: number;
  dryMassKg: number;
  ispS: number;
  acceptablePc: number;
  missionPriority: Priority;
  protected: { day: number; from: string; to: string; reason: string }[];
  preferred: { day: number; from: string; to: string; reason: string }[];
}

const rf = (reserve: number, fuel: number): DemoSatellitePolicy => ({
  minFuelReserveKg: reserve,
  currentFuelKg: fuel,
  dryMassKg: 29.5,
  ispS: 2100, // electric (field-emission) thruster
  acceptablePc: 1e-4,
  missionPriority: "normal",
  protected: [{ day: 1, from: "03:40", to: "04:05", reason: "Geolocation collection over the Pacific tasking area" }],
  preferred: [{ day: 1, from: "06:10", to: "06:25", reason: "Ground contact, Svalbard" }],
});

const cubesat = (fuel: number): DemoSatellitePolicy => ({
  minFuelReserveKg: 0.02,
  currentFuelKg: fuel,
  dryMassKg: 4.6,
  ispS: 65, // cold gas
  acceptablePc: 2e-4,
  missionPriority: "low",
  protected: [],
  preferred: [{ day: 1, from: "09:30", to: "09:45", reason: "Ground contact, Moscow" }],
});

export const DEMO_POLICY: Record<string, DemoSatellitePolicy> = {
  // American Satellite Dynamics: RF sensing cluster
  "56191": rf(0.05, 0.21),
  "56193": rf(0.05, 0.18),
  "56200": rf(0.05, 0.24),
  "62382": { ...rf(0.06, 0.31), missionPriority: "high", protected: [{ day: 1, from: "01:15", to: "01:40", reason: "Customer collection window, contracted" }] },
  // Sever Imaging: CubeSats and one 6U imager
  "64880": cubesat(0.07),
  "64890": cubesat(0.06),
  "57178": cubesat(0.05),
  "57182": {
    minFuelReserveKg: 0.03,
    currentFuelKg: 0.11,
    dryMassKg: 9.2,
    ispS: 70,
    acceptablePc: 1e-4,
    missionPriority: "high",
    protected: [{ day: 1, from: "04:10", to: "04:25", reason: "Imaging pass over the Urals, customer order" }],
    preferred: [{ day: 1, from: "07:50", to: "08:05", reason: "Ground contact, Moscow" }],
  },
  // Jade Orbit: imaging and weather
  "43023": {
    minFuelReserveKg: 1.5,
    currentFuelKg: 6.4,
    dryMassKg: 96,
    ispS: 220, // hydrazine
    acceptablePc: 5e-5,
    missionPriority: "high",
    protected: [{ day: 1, from: "02:30", to: "02:50", reason: "Imaging pass, agricultural survey" }],
    preferred: [{ day: 1, from: "11:20", to: "11:35", reason: "Ground contact, Changchun" }],
  },
  "54686": {
    minFuelReserveKg: 0.8,
    currentFuelKg: 3.1,
    dryMassKg: 48,
    ispS: 220,
    acceptablePc: 1e-4,
    missionPriority: "normal",
    protected: [],
    preferred: [{ day: 1, from: "12:05", to: "12:20", reason: "Ground contact, Wuhan" }],
  },
  "58646": { minFuelReserveKg: 0.3, currentFuelKg: 1.25, dryMassKg: 28, ispS: 1200, acceptablePc: 1e-4, missionPriority: "normal", protected: [], preferred: [{ day: 1, from: "05:40", to: "05:55", reason: "Radio occultation downlink" }] },
  "58647": { minFuelReserveKg: 0.3, currentFuelKg: 1.1, dryMassKg: 28, ispS: 1200, acceptablePc: 1e-4, missionPriority: "normal", protected: [], preferred: [{ day: 1, from: "05:55", to: "06:10", reason: "Radio occultation downlink" }] },
};

export const DEMO_SETTINGS: Record<string, { language: "en" | "ru" | "zh"; contact: string }> = {
  asd: { language: "en", contact: "ops-desk@asd.example · +1 720 555 0142 (24/7 duty desk)" },
  sever: { language: "ru", contact: "mcc@sever.example · +7 495 555 0199 (дежурная смена)" },
  jade: { language: "zh", contact: "ops@jadeorbit.example · +86 10 5555 0188 (值班)" },
};

/** "YYYY-MM-DDTHH:MM" in UTC, `day` days from today. */
export function utcSlot(day: number, hhmm: string, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day));
  return `${d.toISOString().slice(0, 10)}T${hhmm}`;
}
