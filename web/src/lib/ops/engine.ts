"use client";

import type { Catalog, SatObject } from "@/lib/catalog/client";
import { useOrbit } from "@/lib/store";
import { buildEncounter, measureMiss, type Encounter } from "./encounter";
import { AGENTS, costOf } from "./roster";
import { useOps } from "./store";
import type { AgentId, Approval, ConjunctionEvent, HumanId, LogLevel, LogLine, NodeId, Party, Span, SpanKind, SpaceObjectRef } from "./types";
import { OWNER_FLAGS } from "@/lib/owners";

// Dev simulator. Scenarios are async scripts on a virtual clock, so pause, speed
// and reset apply to everything at once. Every write goes through the ops store,
// the same store the backend adapter will fill, so the UI can't tell them apart.

export class Cancelled extends Error {}

export interface SpanSpec {
  agent: AgentId;
  target: NodeId;
  kind: SpanKind;
  name: string;
  eventId?: string | null;
  parent?: string | null;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  reasoning?: string;
  input?: unknown;
  output?: unknown;
  http?: { method: string; url: string; status?: number; bytes?: number };
  /** Finish the span as an error with this message. */
  fail?: string;
}

export interface Decision {
  decision: Exclude<Approval, "pending">;
  note?: string;
  /** Counter as a structured choice (spec §2 #4). */
  preferred?: { mover: "a" | "b" | "none"; action: "raise" | "lower" | "wait" };
  /** Original wording before translation. */
  original?: string;
  lang?: string;
}

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

export class Engine {
  /** Virtual milliseconds since the engine started. */
  vt = 0;
  readonly encounters = new Map<string, Encounter>();
  encounterListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private sleepers: { at: number; resolve: () => void; reject: (e: Error) => void; gen: number }[] = [];
  private running = new Map<string, { v0: number; ms: number }>();
  private gen = 0;
  private humanWaits = new Map<string, (d: Decision) => void>();
  private patrolGen = -1;
  private seq = 4100;

  /* ------------------------------------------------------------- clock */

  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = performance.now();
    const real = now - this.last;
    this.last = now;
    const ops = useOps.getState();
    if (!ops.playing) return;
    this.vt += real * ops.speed;
    const due = this.sleepers.filter((s) => s.at <= this.vt);
    if (due.length) {
      this.sleepers = this.sleepers.filter((s) => s.at > this.vt);
      due.forEach((s) => s.resolve());
    }
    if (this.running.size) {
      const prog = new Map<string, number>();
      this.running.forEach((r, id) => prog.set(id, Math.min((this.vt - r.v0) / r.ms, 1)));
      useOps.setState((s) => ({
        spans: s.spans.map((sp) => (prog.has(sp.id) && sp.status === "running" ? { ...sp, progress: prog.get(sp.id)! } : sp)),
      }));
    }
  }

  sleep(ms: number, gen = this.gen): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (gen !== this.gen) return reject(new Cancelled());
      this.sleepers.push({ at: this.vt + ms, resolve, reject, gen });
    }).then(() => {
      if (gen !== this.gen) throw new Cancelled();
    });
  }

  /** Stop every script and clear the board. */
  reset() {
    this.gen++;
    this.sleepers.forEach((s) => s.reject(new Cancelled()));
    this.sleepers = [];
    this.running.clear();
    this.humanWaits.clear();
    this.encounters.clear();
    this.encounterListeners.forEach((f) => f());
    useOps.setState({
      events: [],
      spans: [],
      logs: [],
      humans: [],
      focusEvent: null,
      focusSpan: null,
      focusAgent: null,
      scenario: null,
      scenarioDone: false,
      scanning: false,
      lastScan: null,
      validation: null,
      replies: [],
      alert: null,
      scan: { phase: "idle", ids: [], stats: null },
    });
  }

  /** Start a script on the current board without clearing it (a case picked from scan results). */
  runOn(id: string, script: (eng: Engine, gen: number) => Promise<void>) {
    this.gen++;
    this.sleepers.forEach((s) => s.reject(new Cancelled()));
    this.sleepers = [];
    this.running.clear();
    this.humanWaits.clear();
    useOps.setState({ humans: [], scenario: id, scenarioDone: false, playing: true, scanning: false });
    const gen = this.gen;
    this.patrol();
    void (async () => {
      try {
        await script(this, gen);
        if (gen === this.gen) {
          useOps.setState({ scenarioDone: true });
          this.log("system", "Incident run finished", "info");
        }
      } catch (e) {
        if (!(e instanceof Cancelled)) {
          console.error(e);
          this.log("system", `Run crashed: ${(e as Error).message}`, "error");
        }
      }
    })();
  }

  get generation() {
    return this.gen;
  }

  /* ------------------------------------------------------------- writes */

  log(source: LogLine["source"], msg: string, level: LogLevel = "info", extra: Partial<LogLine> = {}) {
    const line: LogLine = { id: uid("log"), t: Date.now(), level, source, msg, ...extra };
    useOps.setState((s) => ({ logs: [...s.logs.slice(-499), line] }));
  }

  update(id: string, patch: Partial<ConjunctionEvent> | ((e: ConjunctionEvent) => Partial<ConjunctionEvent>)) {
    useOps.setState((s) => ({
      events: s.events.map((e) => (e.id === id ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) } : e)),
    }));
  }

  event(id: string) {
    return useOps.getState().events.find((e) => e.id === id) ?? null;
  }

  nextId() {
    return `CE-${++this.seq}`;
  }

  addEvent(e: ConjunctionEvent, enc: Encounter | null) {
    if (enc) this.encounters.set(e.id, enc);
    useOps.setState((s) => ({ events: [e, ...s.events] }));
    this.encounterListeners.forEach((f) => f());
  }

  /** Run one traced step: a model call, a tool call or a handoff. */
  async span(spec: SpanSpec, ms: number, gen = this.gen): Promise<Span> {
    if (gen !== this.gen) throw new Cancelled();
    const id = uid("sp");
    const span: Span = {
      id,
      parent: spec.parent ?? null,
      eventId: spec.eventId ?? null,
      agent: spec.agent,
      target: spec.target,
      kind: spec.kind,
      name: spec.name,
      status: "running",
      t0: Date.now(),
      progress: 0,
      model: spec.model ?? (spec.kind === "llm" ? AGENTS[spec.agent].model : undefined),
      tokensIn: spec.tokensIn,
      tokensOut: spec.tokensOut,
      cacheRead: spec.cacheRead,
      reasoning: spec.reasoning,
      input: spec.input,
      http: spec.http ? { method: spec.http.method, url: spec.http.url } : undefined,
    };
    useOps.setState((s) => ({ spans: [...s.spans.slice(-399), span] }));
    this.running.set(id, { v0: this.vt, ms });
    try {
      await this.sleep(ms, gen);
    } finally {
      this.running.delete(id);
    }
    const cost =
      span.model && spec.tokensIn !== undefined ? costOf(span.model, spec.tokensIn, spec.tokensOut ?? 0, spec.cacheRead ?? 0) : undefined;
    const done: Partial<Span> = {
      status: spec.fail ? "error" : "ok",
      progress: 1,
      ms,
      t1: Date.now(),
      costUsd: cost,
      output: spec.output,
      error: spec.fail,
      http: spec.http ? { ...spec.http, status: spec.http.status ?? 200 } : undefined,
    };
    useOps.setState((s) => ({ spans: s.spans.map((x) => (x.id === id ? { ...x, ...done } : x)) }));
    const tail = [`${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`];
    if (spec.tokensIn !== undefined) tail.push(`${spec.tokensIn.toLocaleString("en-US")} in / ${(spec.tokensOut ?? 0).toLocaleString("en-US")} out`);
    if (typeof cost === "number") tail.push(`$${cost.toFixed(4)}`);
    if (spec.http) tail.push(`HTTP ${spec.http.status ?? 200}`);
    this.log(spec.agent, `${spec.fail ? "✕" : "✓"} ${spec.name} · ${tail.join(" · ")}`, spec.fail ? "error" : "info", {
      spanId: id,
      eventId: spec.eventId ?? undefined,
    });
    return { ...span, ...done } as Span;
  }

  /* ------------------------------------------------------------- humans */

  /** Ask one operator for a decision. Autopilot answers with `auto` after a short pause. */
  async human(eventId: string, side: "a" | "b", version: number, auto: Decision, gen = this.gen): Promise<Decision> {
    if (gen !== this.gen) throw new Cancelled();
    const key = `${eventId}:${side}`;
    useOps.setState((s) => ({ humans: [...s.humans.filter((h) => !(h.eventId === eventId && h.side === side)), { eventId, side, proposalVersion: version }] }));
    const d = await new Promise<Decision>((resolve, reject) => {
      this.humanWaits.set(key, resolve);
      const st = useOps.getState();
      if (st.autopilot && st.actAs !== side) {
        this.sleep(side === "a" ? 4200 : 6800, gen)
          .then(() => {
            if (this.humanWaits.get(key) === resolve) this.decide(eventId, side, auto);
          })
          .catch(reject);
      } else {
        // a reset rejects the wait through the generation check on the next sleep
        this.sleep(1e12, gen).catch(reject);
      }
    });
    if (gen !== this.gen) throw new Cancelled();
    return d;
  }

  decide(eventId: string, side: "a" | "b", d: Decision) {
    const key = `${eventId}:${side}`;
    const fn = this.humanWaits.get(key);
    if (!fn) return;
    this.humanWaits.delete(key);
    useOps.setState((s) => ({ humans: s.humans.filter((h) => !(h.eventId === eventId && h.side === side)) }));
    this.update(eventId, (e) => ({ approvals: { ...e.approvals, [side]: d.decision } }));
    useOps.setState((s) => ({
      replies: [...s.replies.slice(-30), { eventId, side, decision: d.decision, note: d.note, original: d.original, lang: d.lang, t: Date.now() }],
    }));
    this.log(side === "a" ? "humanA" : "humanB", `${d.decision === "approved" ? "Approved" : d.decision === "vetoed" ? "Vetoed" : "Countered"} proposal${d.note ? ` · “${d.note}”` : ""}`, d.decision === "approved" ? "info" : "warn", { eventId });
    fn(d);
  }

  /* -------------------------------------------------------------- patrol */

  /** Background screening passes while no scenario is running. */
  patrol() {
    if (this.patrolGen === this.gen) return;
    const gen = (this.patrolGen = this.gen);
    void (async () => {
      try {
        await this.sleep(1200, gen);
        while (gen === this.gen) {
          // idle passes are slower than the real 5–15 min cadence would suggest, but often
          // enough that the screen never looks dead while building the UI
          const st = useOps.getState();
          if (!st.scenario || st.scenarioDone) await screeningPass(this, gen, null);
          await this.sleep(22_000, gen);
        }
      } catch (e) {
        if (!(e instanceof Cancelled)) console.error(e);
      }
    })();
  }

  /** Start a scenario script from a clean board. */
  run(id: string, script: (eng: Engine, gen: number) => Promise<void>) {
    this.reset();
    const gen = this.gen;
    useOps.setState({ scenario: id, scenarioDone: false, playing: true });
    seedBoard(this);
    this.patrol();
    void (async () => {
      try {
        await script(this, gen);
        if (gen === this.gen) {
          useOps.setState({ scenarioDone: true });
          this.log("system", "Scenario finished", "info");
        }
      } catch (e) {
        if (!(e instanceof Cancelled)) {
          console.error(e);
          this.log("system", `Scenario crashed: ${(e as Error).message}`, "error");
        }
      }
    })();
  }

  /** Dev mode on: seed the queue and keep the Risk Monitor patrolling. */
  boot() {
    this.start();
    if (!useOps.getState().events.length) seedBoard(this);
    this.patrol();
  }
}

export const engine = new Engine();

/* -------------------------------------------------------------- helpers */

export function catalog(): Catalog | null {
  return useOrbit.getState().catalog;
}

/** Deterministic pick of a real object with a fresh element set. */
export function pickObject(pred: (o: SatObject) => boolean, salt = 0): SatObject | null {
  const cat = catalog();
  if (!cat) return null;
  const now = Date.now();
  const pool = cat.objects.filter((o) => pred(o) && now - o.epoch.getTime() < 4 * 86400_000);
  if (!pool.length) return null;
  return pool[(salt * 7919) % pool.length];
}

export function refOf(o: SatObject, operator: string): SpaceObjectRef {
  return {
    norad: o.norad,
    name: o.name,
    owner: o.owner,
    operator,
    kind: o.category === "debris" ? "debris" : "payload",
    catalogIndex: o.index,
    synthetic: false,
  };
}

const LANGUAGE: Record<string, string> = {
  us: "English",
  gb: "English",
  in: "English",
  ru: "Russian",
  cn: "Chinese",
  jp: "Japanese",
  fr: "French",
  de: "German",
  it: "Italian",
  es: "Spanish",
  kr: "Korean",
  ca: "English",
};

/** A party from an operator and its SATCAT owner code. */
export function partyOf(id: HumanId, role: Party["role"], operator: string, owner: string): Party {
  const country = OWNER_FLAGS[owner]?.[0] ?? null;
  return { id, role, operator, owner, country, language: country ? (LANGUAGE[country] ?? null) : null };
}

export interface EventSeed {
  a: SatObject;
  aOperator: string;
  b: Omit<SpaceObjectRef, "catalogIndex" | "synthetic">;
  tcaInH: number;
  missM: number;
  crossDeg: number;
  pc: number;
  risk: ConjunctionEvent["risk"];
  trend?: ConjunctionEvent["trend"];
  status?: ConjunctionEvent["status"];
  uncertaintyM?: number;
  pcSource?: ConjunctionEvent["pcSource"];
  scenario?: string;
}

/** Create an event with a real synthetic geometry around a live object. */
export function makeEvent(eng: Engine, s: EventSeed & { confidence?: ConjunctionEvent["confidence"] }): ConjunctionEvent | null {
  const tca = Date.now() + s.tcaInH * 3600_000;
  const enc = buildEncounter(s.a.line1, s.a.line2, tca, { missM: s.missM, crossDeg: s.crossDeg });
  if (!enc) return null;
  const check = measureMiss(enc);
  // keep the numbers honest: what the globe shows is what the card says
  const missM = Math.round(check.missM);
  const hist: ConjunctionEvent["pcHistory"] = [];
  const steps = 9;
  for (let k = 0; k < steps; k++) {
    const f = k / (steps - 1);
    const drift = s.trend === "falling" ? 2.6 - 1.6 * f : s.trend === "flat" ? 1 + 0.15 * Math.sin(k) : 0.06 + 0.94 * f * f;
    hist.push({ t: Date.now() - (steps - 1 - k) * 3 * 3600_000, pc: s.pc * drift });
  }
  const e: ConjunctionEvent = {
    id: eng.nextId(),
    a: refOf(s.a, s.aOperator),
    b: { ...s.b, catalogIndex: null, synthetic: true },
    tca,
    missM,
    uncertaintyM: s.uncertaintyM ?? Math.round(missM * 0.35 + 40),
    radialM: Math.round(enc.radialM),
    pc: s.pc,
    pcSource: s.pcSource ?? "SOCRATES",
    relVelKms: enc.relVelKms,
    risk: s.risk,
    trend: s.trend ?? "rising",
    pcHistory: hist,
    status: s.status ?? "new",
    agentsWorking: false,
    where: enc.where,
    proposal: null,
    approvals: { a: "pending", b: "pending" },
    summary: null,
    parties: [partyOf("humanA", "a", s.aOperator, s.a.owner), ...(s.b.kind === "payload" ? [partyOf("humanB", "b", s.b.operator, s.b.owner)] : [])],
    createdAt: Date.now(),
    scenario: s.scenario,
    confidence: s.confidence,
  };
  eng.addEvent(e, enc);
  return e;
}

/** A quiet board: a few yellow events and history, so the queue never starts empty. */
function seedBoard(eng: Engine) {
  const cat = catalog();
  if (!cat) return;
  const oneweb = pickObject((o) => o.category === "oneweb", 3);
  const gnss = pickObject((o) => o.category === "other" && o.perigeeKm > 600 && o.perigeeKm < 900, 5);
  const starlink = pickObject((o) => o.category === "starlink", 11);
  if (oneweb)
    makeEvent(eng, {
      a: oneweb,
      aOperator: "Eutelsat OneWeb",
      b: { norad: 90_000 + 412, name: "FENGYUN 1C DEB (SYN)", owner: "PRC", operator: "Debris · no operator", kind: "debris" },
      tcaInH: 52,
      missM: 840,
      crossDeg: 96,
      pc: 3.8e-5,
      risk: "yellow",
      trend: "falling",
      status: "monitoring",
    });
  if (gnss)
    makeEvent(eng, {
      a: gnss,
      aOperator: cat.owners[gnss.owner] ?? gnss.owner,
      b: { norad: 90_000 + 87, name: "COSMOS 2251 DEB (SYN)", owner: "CIS", operator: "Debris · no operator", kind: "debris" },
      tcaInH: 67,
      missM: 1210,
      crossDeg: 118,
      pc: 1.6e-5,
      risk: "yellow",
      trend: "flat",
    });
  if (starlink)
    makeEvent(eng, {
      a: starlink,
      aOperator: "SpaceX Starlink",
      b: { norad: 90_000 + 233, name: "TALON-3 (SYN)", owner: "UK", operator: "Talon Orbital (synthetic)", kind: "payload" },
      tcaInH: 39,
      missM: 2300,
      crossDeg: 64,
      pc: 1.2e-5,
      risk: "yellow",
      trend: "falling",
      status: "no_action",
    });
}

/** Keep only the last `keep` background passes in the trace; they repeat and would bury the incident steps. */
function prunePatrol(keep: number) {
  const spans = useOps.getState().spans;
  const roots = spans.filter((s) => isPatrolRoot(s));
  if (roots.length <= keep) return;
  const drop = new Set(roots.slice(0, roots.length - keep).map((r) => r.id));
  useOps.setState({ spans: spans.filter((s) => !drop.has(s.id) && !(s.parent && drop.has(s.parent))) });
}

export const isPatrolRoot = (s: { agent: string; eventId: string | null; parent: string | null; kind: string }) =>
  s.agent === "monitor" && s.eventId === null && s.parent === null && s.kind === "http";

/** One Risk Monitor pass: screen, cross-check SOCRATES and CDMs, rank. */
export async function screeningPass(eng: Engine, gen: number, flag: { eventId: string } | null) {
  const cat = catalog();
  const n = cat?.objects.length ?? 0;
  const pairs = Math.round((n * (n - 1)) / 2);
  if (!flag) prunePatrol(2);
  useOps.setState({ scanning: true });
  const t0 = Date.now();
  try {
    const root = await eng.span(
      {
        agent: "monitor",
        target: "celestrak",
        kind: "http",
        name: "Pull GP catalog",
        http: { method: "GET", url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json", bytes: 9_420_118 },
        output: { objects: n, cache: "hit · < 2 h old" },
      },
      620,
      gen,
    );
    await eng.span(
      {
        agent: "monitor",
        target: "sgp4",
        kind: "tool",
        name: "screen_catalog",
        parent: root.id,
        input: { objects: n, horizon_h: 72, threshold_km: 5, step_s: 60 },
        output: { pairs_checked: pairs, within_5km: flag ? 38 : 31 + Math.floor(Math.random() * 9), within_1km: flag ? 4 : 2 },
      },
      4200,
      gen,
    );
    await Promise.all([
      eng.span(
        {
          agent: "monitor",
          target: "socrates",
          kind: "http",
          name: "Cross-check SOCRATES",
          parent: root.id,
          http: { method: "GET", url: "https://celestrak.org/SOCRATES/" },
          output: { matched_within_500m: 47, of: 50 },
        },
        900,
        gen,
      ),
      eng.span(
        {
          agent: "monitor",
          target: "spacetrack",
          kind: "http",
          name: "Fetch public CDMs",
          parent: root.id,
          http: { method: "GET", url: "https://www.space-track.org/basicspacedata/query/class/cdm_public/orderby/TCA asc/format/json" },
          output: { cdms: 214, emergency_reportable: flag ? 1 : 0 },
        },
        1100,
        gen,
      ),
    ]);
    await eng.span(
      {
        agent: "monitor",
        target: "convex",
        kind: "llm",
        name: "Rank queue",
        parent: root.id,
        tokensIn: 6_840,
        tokensOut: 412,
        cacheRead: 5_200,
        reasoning: flag
          ? `Ranking by Pc / hours-to-TCA with the fuel and trend adjustments. ${flag.eventId} has the highest score this pass and crosses both red thresholds (Pc > 1e-4, TCA < 72 h). It also appears in SOCRATES and in a public CDM, so it gets the cross-source priority bump. Waking the Incident Analyst for this one event only; everything else stays yellow in the feed.`
          : `Ranking by Pc / hours-to-TCA. Nothing crosses the red line this pass: the highest Pc is below 1e-4 and the falling-trend events keep falling. Queue order unchanged except one yellow moving up two places. No agents to wake.`,
        output: flag ? { red: 1, yellow: 3, woke: ["analyst"] } : { red: 0, yellow: 3, woke: [] },
      },
      1300,
      gen,
    );
    useOps.setState({
      lastScan: { at: Date.now(), objects: n, pairs, flagged: flag ? 1 : 0, ms: Date.now() - t0 },
      validation: { matchedWithin500m: 47, of: 50, at: Date.now() },
    });
  } finally {
    if (gen === eng.generation) useOps.setState({ scanning: false });
  }
}
