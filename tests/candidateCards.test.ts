import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  mapCandidates, parseCandidatesResponse, stableCandidateId,
  type CardContext, type OrbitCandidatesResponse,
} from "../convex/lib/candidateCards";
import { validateCandidates, type Candidate } from "../convex/lib/policies";
import { advocateEvent } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import type { EventFacts } from "../convex/lib/analyst";

// advocateEvent: SIM-1001 (A) and SIM-1002 (B), closest approach 2026-10-25T03:14:07Z, miss 0.18 km.
const at = (hoursBeforeTca: number) =>
  new Date(Date.parse(advocateEvent.tcaUtc) - hoursBeforeTca * 3_600_000).toISOString().replace(".000Z", "Z");
type Item = OrbitCandidatesResponse["candidates"][number];
const maneuver = (over: Partial<Item> = {}): Item => ({
  kind: "maneuver", movingObjectId: "SIM-1001", burnTimeUtc: at(6), direction: "prograde",
  deltaVMs: 0.05, estimatedFuelKg: 0.12, missAfterKm: 1.4, reviewCondition: null,
  assumptions: ["Along-track impulse; indicative geometry."], ...over,
});
const wait = (over: Partial<Item> = {}): Item => ({
  kind: "wait", movingObjectId: null, burnTimeUtc: null, direction: null, deltaVMs: null,
  estimatedFuelKg: null, missAfterKm: null, reviewCondition: "Reassess when a new source observation arrives.",
  assumptions: ["Waiting is not a claim of safety."], ...over,
});
const response = (candidates: Item[], over: Partial<OrbitCandidatesResponse> = {}): OrbitCandidatesResponse => ({
  eventId: "event-1", evidenceVersion: "evidence-7", snapshotId: "snapshot-3", simulated: false, candidates, ...over,
});
const context = (over: Partial<CardContext> = {}): CardContext => ({
  facts: advocateEvent, activeSide: "A", counterpartSide: "B", previous: [], nowMs: FIXTURE_NOW,
  eventId: "event-1", evidenceVersion: "evidence-7", snapshotId: "snapshot-3", ...over,
});
const realFacts: EventFacts = {
  ...advocateEvent, simulated: false,
  objectA: { ...advocateEvent.objectA, objectId: "12345", simulated: false },
  objectB: { ...advocateEvent.objectB, objectId: "25544", simulated: false },
};
function expectValidation(fn: () => unknown) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe("VALIDATION");
    return;
  }
  throw new Error("Expected a VALIDATION error.");
}

describe("parseCandidatesResponse", () => {
  it("accepts the provisional /candidates shape", () => {
    const value = response([maneuver(), wait()]);
    expect(parseCandidatesResponse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseCandidatesResponse(response(Array.from({ length: 100 }, () => wait()))).candidates).toHaveLength(100);
  });
  it.each<[string, unknown]>([
    ["non-object", "nope"],
    ["missing echo", (({ snapshotId: _omitted, ...rest }) => rest)(response([]))],
    ["more than 100 candidates", response(Array.from({ length: 101 }, () => wait()))],
    ["extra top-level field", { ...response([]), pc: 0.0002 }],
    ["extra candidate field", response([{ ...maneuver(), postManeuverPc: 1e-6 } as Item])],
    ["unknown kind", response([{ ...maneuver(), kind: "abort" } as unknown as Item])],
    ["unknown direction", response([maneuver({ direction: "radial" as "prograde" })])],
    ["numeric object id", response([maneuver({ movingObjectId: 1001 as unknown as string })])],
    ["non-finite delta-v", response([maneuver({ deltaVMs: Infinity })])],
    ["string fuel", response([maneuver({ estimatedFuelKg: "0.1" as unknown as number })])],
    ["non-string assumption", response([maneuver({ assumptions: [7 as unknown as string] })])],
    ["non-boolean simulated", { ...response([]), simulated: "yes" }],
    ["candidates not an array", { ...response([]), candidates: {} }],
  ])("rejects %s", (_name, value) => {
    expectValidation(() => parseCandidatesResponse(value));
  });
});

describe("stableCandidateId", () => {
  it("is deterministic, ID-safe and depends only on geometry", () => {
    const geometry = { kind: "maneuver" as const, movingObjectId: "SIM-1001", burnTimeUtc: at(6), direction: "prograde", deltaVMs: 0.05 };
    const id = stableCandidateId(geometry);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(stableCandidateId({ ...geometry })).toBe(id);
    expect(stableCandidateId({ ...geometry, burnTimeUtc: geometry.burnTimeUtc.replace("Z", ".000Z") })).toBe(id);
    for (const change of [{ deltaVMs: 0.1 }, { direction: "retrograde" }, { burnTimeUtc: at(3) }, { movingObjectId: "SIM-1002" }]) {
      expect(stableCandidateId({ ...geometry, ...change })).not.toBe(id);
    }
    const waitId = stableCandidateId({ kind: "wait", movingObjectId: null, burnTimeUtc: null, direction: null, deltaVMs: null });
    expect(waitId).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(waitId).not.toBe(id);
  });
});

describe("mapCandidates", () => {
  it("maps service results into cards that pass validateCandidates", () => {
    const cards = mapCandidates(response([maneuver(), maneuver({ movingObjectId: "SIM-1002", direction: "retrograde", burnTimeUtc: at(12) }), wait()]), context());
    expect(() => validateCandidates(cards, advocateEvent)).not.toThrow();
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({
      kind: "maneuver", movingSide: "A", movingObjectId: "SIM-1001", deltaVMs: 0.05, direction: "prograde",
      estimatedFuelKg: 0.12, missBeforeKm: 0.18, missAfterKm: 1.4, indicative: true, reviewCondition: null, revision: 1,
      assumptions: ["Along-track impulse; indicative geometry."],
    });
    expect(cards[1]).toMatchObject({ movingSide: "B", movingObjectId: "SIM-1002" });
    expect(cards[2]).toMatchObject({
      kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null, deltaVMs: null, direction: null,
      estimatedFuelKg: null, missAfterKm: null, reviewCondition: "Reassess when a new source observation arrives.",
    });
    expect(cards.map(c => c.candidateId)).toEqual([maneuver(), maneuver({ movingObjectId: "SIM-1002", direction: "retrograde", burnTimeUtc: at(12) }), wait()].map(stableCandidateId));
  });
  it("labels cards readably within 80 characters and without probability", () => {
    const cards = mapCandidates(response([maneuver(), maneuver({ burnTimeUtc: at(12), deltaVMs: 0.2, direction: "retrograde" }), wait()]), context());
    expect(cards.map(c => c.label)).toEqual([
      "Move SIM-1001 prograde 0.05 m/s, 6 h before closest approach",
      "Move SIM-1001 retrograde 0.2 m/s, 12 h before closest approach",
      "Wait for update",
    ]);
    for (const card of cards) expect(card.label.length).toBeLessThanOrEqual(80);
    const text = JSON.stringify(cards);
    expect(text).not.toContain(String(advocateEvent.pc.value));
    expect(text.toLowerCase()).not.toMatch(/\bpc\b|probability/);
  });
  it("shows minutes for burns under an hour before closest approach", () => {
    const [card] = mapCandidates(response([maneuver({ burnTimeUtc: at(0.75) })]), context());
    expect(card.label).toBe("Move SIM-1001 prograde 0.05 m/s, 45 min before closest approach");
  });
  it("rounds delta-v for display only", () => {
    const [card] = mapCandidates(response([maneuver({ deltaVMs: 0.0512345678 })]), context());
    expect(card.label).toBe("Move SIM-1001 prograde 0.0512 m/s, 6 h before closest approach");
    expect(card.deltaVMs).toBe(0.0512345678);
    expect(card.candidateId).toBe(stableCandidateId(maneuver({ deltaVMs: 0.0512345678 })));
    expect(card.candidateId).not.toBe(stableCandidateId(maneuver({ deltaVMs: 0.0512 })));
  });
  it("shortens labels that would exceed 80 characters", () => {
    const withObject = (objectId: string): [CardContext, Item] => [
      context({ facts: { ...advocateEvent, objectA: { ...advocateEvent.objectA, objectId } } }), maneuver({ movingObjectId: objectId }),
    ];
    const [mediumContext, medium] = withObject("SIM-" + "1".repeat(36));
    expect(mapCandidates(response([medium]), mediumContext)[0].label).toBe(`Move SIM-${"1".repeat(36)} prograde 0.05 m/s`);
    const [longContext, long] = withObject("SIM-" + "1".repeat(90));
    const [card] = mapCandidates(response([long]), longContext);
    expect(card.label).toHaveLength(80);
    expect(card.label.startsWith("Move SIM-111")).toBe(true);
  });
  it("drops burns at or before now and never pads to four", () => {
    const cards = mapCandidates(response([
      maneuver({ burnTimeUtc: at(16) }), maneuver({ burnTimeUtc: new Date(FIXTURE_NOW).toISOString() }), maneuver(),
    ]), context());
    expect(cards).toHaveLength(1);
    expect(cards[0].burnTimeUtc).toBe(at(6));
    expect(mapCandidates(response([]), context())).toEqual([]);
  });
  it("includes a wait card only when the service returned one", () => {
    expect(mapCandidates(response([maneuver()]), context()).some(c => c.kind === "wait")).toBe(false);
    expect(mapCandidates(response([wait()]), context()).map(c => c.kind)).toEqual(["wait"]);
  });
  it("keeps the first four distinct candidates in service order when given more", () => {
    const items = [
      maneuver({ deltaVMs: 0.02 }), maneuver({ deltaVMs: 0.02 }), maneuver({ deltaVMs: 0.05 }),
      maneuver({ deltaVMs: 0.1 }), maneuver({ deltaVMs: 0.2 }), maneuver({ deltaVMs: 0.3 }),
    ];
    const cards = mapCandidates(response(items), context());
    expect(cards.map(c => c.deltaVMs)).toEqual([0.02, 0.05, 0.1, 0.2]);
    expect(mapCandidates(response(items), context())).toEqual(cards);
  });
  it("rejects a maneuver that moves an object outside the event", () => {
    expectValidation(() => mapCandidates(response([maneuver({ movingObjectId: "99999" })]), context()));
  });
  const invalidGeometry = [
    maneuver({ deltaVMs: 0 }), maneuver({ deltaVMs: -0.05 }), maneuver({ burnTimeUtc: at(-1) }),
    maneuver({ burnTimeUtc: at(0) }), maneuver({ burnTimeUtc: null }), maneuver({ direction: null }),
    maneuver({ reviewCondition: "later" }), wait({ reviewCondition: null }), wait({ reviewCondition: "  " }),
    wait({ deltaVMs: 0.05 }), wait({ movingObjectId: "SIM-1001" }),
  ];
  it("drops a card with invalid geometry instead of repairing it", () => {
    for (const bad of invalidGeometry) expect(mapCandidates(response([bad]), context())).toEqual([]);
  });
  it("does not let dropped cards consume one of the four slots", () => {
    const good = [0.02, 0.05, 0.1, 0.2].map(deltaVMs => maneuver({ deltaVMs }));
    const cards = mapCandidates(response([...invalidGeometry, ...good]), context());
    expect(cards.map(c => c.deltaVMs)).toEqual([0.02, 0.05, 0.1, 0.2]);
  });
  it("keeps a valid wait card after four maneuvers by keeping only three maneuvers", () => {
    const four = [0.02, 0.05, 0.1, 0.2].map(deltaVMs => maneuver({ deltaVMs }));
    const cards = mapCandidates(response([...four, wait()]), context());
    expect(cards.map(c => c.kind)).toEqual(["maneuver", "maneuver", "maneuver", "wait"]);
    expect(cards.map(c => c.deltaVMs)).toEqual([0.02, 0.05, 0.1, null]);
    expect(mapCandidates(response([...four, wait({ reviewCondition: null })]), context()).map(c => c.deltaVMs)).toEqual([0.02, 0.05, 0.1, 0.2]);
  });
  it("rejects results that echo a different event, evidence version or snapshot", () => {
    for (const over of [{ eventId: "event-2" }, { evidenceVersion: "evidence-6" }, { snapshotId: "snapshot-2" }]) {
      expectValidation(() => mapCandidates(response([maneuver()], over), context()));
    }
  });
  it("re-checks the wire shape even for typed input", () => {
    const widened = { ...response([maneuver()]), postManeuverPc: 1e-6 } as OrbitCandidatesResponse;
    expectValidation(() => mapCandidates(widened, context()));
  });

  describe("revisions", () => {
    it("reuses a revision for unchanged content regardless of key order", () => {
      const [first] = mapCandidates(response([maneuver()]), context());
      const reordered = Object.fromEntries(Object.entries({ ...first, revision: 3 }).reverse()) as typeof first;
      const [again] = mapCandidates(response([maneuver()]), context({ previous: [reordered] }));
      expect(again.revision).toBe(3);
      expect(again.candidateId).toBe(first.candidateId);
    });
    it("bumps the previous revision when content changed under the same ID", () => {
      const [first] = mapCandidates(response([maneuver()]), context());
      const [changed] = mapCandidates(response([maneuver({ missAfterKm: 2.2 })]), context({ previous: [{ ...first, revision: 2 }] }));
      expect(changed.candidateId).toBe(first.candidateId);
      expect(changed.revision).toBe(3);
      const [assumptions] = mapCandidates(response([maneuver({ assumptions: ["New assumption."] })]), context({ previous: [first] }));
      expect(assumptions.revision).toBe(2);
    });
    it("starts new candidates at revision 1 even when other IDs exist", () => {
      const [first] = mapCandidates(response([maneuver()]), context());
      const cards = mapCandidates(response([maneuver(), maneuver({ deltaVMs: 0.1 })]), context({ previous: [{ ...first, revision: 4 }] }));
      expect(cards.map(c => c.revision)).toEqual([4, 1]);
    });
    it("bumps the revision when only the simulated label changes", () => {
      const real = response([maneuver({ movingObjectId: "12345" })]);
      const [first] = mapCandidates(real, context({ facts: realFacts }));
      const [flagged] = mapCandidates({ ...real, simulated: true }, context({ facts: realFacts, previous: [first] }));
      expect(flagged).toMatchObject({ candidateId: first.candidateId, simulated: true, revision: 2 });
    });
  });

  describe("revision sequence against publish's rule", () => {
    // In-memory copy of candidates.publish: a revision at or below the latest stored one must be identical to it.
    type Stored = Candidate & { _id: string; _creationTime: number; eventId: string };
    function store() {
      const rows: Stored[] = [];
      return {
        rows,
        publish(cards: Candidate[]) {
          for (const c of cards) {
            const latest = rows.filter(r => r.candidateId === c.candidateId).sort((a, b) => b.revision - a.revision)[0];
            if (latest && c.revision <= latest.revision) {
              if (c.revision !== latest.revision || Object.keys(c).some(k => JSON.stringify(c[k as keyof Candidate]) !== JSON.stringify(latest[k as keyof Candidate]))) {
                throw new Error("STALE_REVISION");
              }
            } else rows.push({ ...c, _id: `row-${rows.length}`, _creationTime: rows.length, eventId: "event-1" });
          }
          return cards;
        },
      };
    }
    const run = (s: ReturnType<typeof store>, items: Item[], facts: EventFacts = advocateEvent) =>
      s.publish(mapCandidates(response(items), context({ facts, previous: s.rows })));

    it("brings a dropped wait card back with a new revision", () => {
      const s = store();
      expect(run(s, [maneuver(), wait()]).map(c => c.revision)).toEqual([1, 1]);
      run(s, [maneuver()]);
      const back = run(s, [maneuver(), wait({ reviewCondition: "Reassess after the next tracking pass." })]);
      expect(back.map(c => c.revision)).toEqual([1, 2]);
    });
    it("bumps maneuvers that return after the miss distance changed", () => {
      const s = store(), second = maneuver({ deltaVMs: 0.1 });
      run(s, [maneuver(), second]);
      run(s, [maneuver()]);
      const again = run(s, [maneuver(), second], { ...advocateEvent, missKm: 0.25 });
      expect(again.map(c => c.revision)).toEqual([2, 2]);
      expect(again.every(c => c.missBeforeKm === 0.25)).toBe(true);
    });
    it("does not bump an unchanged response published twice", () => {
      const s = store();
      const first = run(s, [maneuver(), wait()]);
      expect(run(s, [maneuver(), wait()])).toEqual(first);
      expect(s.rows).toHaveLength(2);
    });
    it("accepts stored documents as previous revisions", () => {
      const s = store();
      run(s, [maneuver()]);
      expect(s.rows[0]).toHaveProperty("_id");
      const [card] = mapCandidates(response([maneuver()]), context({ previous: s.rows }));
      expect(card.revision).toBe(1);
      expect(card).not.toHaveProperty("_id");
    });
    it("bumps from the highest stored revision", () => {
      const [first] = mapCandidates(response([maneuver()]), context());
      const previous = [first, { ...first, revision: 2, missAfterKm: 1.9 }];
      const [changed] = mapCandidates(response([maneuver({ missAfterKm: 2.5 })]), context({ previous }));
      expect(changed.revision).toBe(3);
      const [matchesLatest] = mapCandidates(response([maneuver({ missAfterKm: 1.9 })]), context({ previous }));
      expect(matchesLatest.revision).toBe(2);
    });
  });

  describe("simulation labels", () => {
    it("follows the event facts and the service flag", () => {
      const realContext = context({ facts: realFacts });
      const real = response([maneuver({ movingObjectId: "12345" }), wait()]);
      expect(mapCandidates(real, realContext).every(c => !c.simulated)).toBe(true);
      expect(mapCandidates({ ...real, simulated: true }, realContext).every(c => c.simulated)).toBe(true);
      expect(mapCandidates(response([maneuver(), wait()]), context()).every(c => c.simulated)).toBe(true);
    });
  });

  describe("debris", () => {
    it("moves only the active side and references no second operator", () => {
      const cards = mapCandidates(response([maneuver(), wait()]), context({ counterpartSide: null }));
      expect(cards.filter(c => c.kind === "maneuver").every(c => c.movingSide === "A" && c.movingObjectId === "SIM-1001")).toBe(true);
      expect(JSON.stringify(cards)).not.toMatch(/operator|company|owner/i);
      const sideB = mapCandidates(response([maneuver({ movingObjectId: "SIM-1002" })]), context({ activeSide: "B", counterpartSide: null }));
      expect(sideB[0].movingSide).toBe("B");
    });
    it("rejects a card that moves the debris object, even when its burn is past", () => {
      expectValidation(() => mapCandidates(response([maneuver({ movingObjectId: "SIM-1002" })]), context({ counterpartSide: null })));
      expectValidation(() => mapCandidates(response([maneuver({ movingObjectId: "SIM-1002", burnTimeUtc: at(16) })]), context({ counterpartSide: null })));
      const fourKept = [0.02, 0.05, 0.1, 0.2].map(deltaVMs => maneuver({ deltaVMs }));
      expectValidation(() => mapCandidates(response([...fourKept, maneuver({ movingObjectId: "SIM-1002" })]), context({ counterpartSide: null })));
    });
    it("rejects a context whose counterpart is the active side", () => {
      expectValidation(() => mapCandidates(response([maneuver()]), context({ counterpartSide: "A" })));
    });
  });
});
