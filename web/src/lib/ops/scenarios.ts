"use client";

import { Cancelled, engine, makeEvent, partyOf, pickObject, screeningPass, type Decision, type Engine } from "./engine";
import { fmtMiss, fmtOdds, fmtPc, fmtWhen } from "./format";
import { useOps } from "./store";
import type { ConjunctionEvent, DecisionOption, Proposal } from "./types";

// User stories from docs/plan-v1.md §6–7 and docs/functionality.md, played as scripts.
// Physics numbers are computed (miss after a burn from the along-track drift 3·Δv·Δt,
// fuel from the rocket equation); only the wording is written by hand.

export interface Scenario {
  id: string;
  title: string;
  story: string;
  refs: string;
  run: (eng: Engine, gen: number, existing?: ConjunctionEvent) => Promise<void>;
}

const G0 = 9.80665;

interface Craft {
  massKg: number;
  ispS: number;
  fuelReservePct: number;
}

const CRAFT_A: Craft = { massKg: 800, ispS: 1500, fuelReservePct: 41 }; // Hall thruster, krypton
const CRAFT_B: Craft = { massKg: 150, ispS: 220, fuelReservePct: 18 }; // hydrazine monoprop

function fuelG(c: Craft, dv: number) {
  return c.massKg * (1 - Math.exp(-dv / (c.ispS * G0))) * 1000;
}

/** Miss after an along-track burn `leadH` hours before TCA (drift 3·Δv·Δt, projected off the relative velocity). */
function missAfter(e: ConjunctionEvent, crossDeg: number, dv: number, leadH: number) {
  const drift = 3 * dv * leadH * 3600;
  const perp = drift * Math.cos(((crossDeg / 2) * Math.PI) / 180);
  return Math.hypot(e.missM, perp);
}

const crossOf = (e: ConjunctionEvent) => engine.encounters.get(e.id)?.crossDeg ?? 64;

function proposal(e: ConjunctionEvent, p: Omit<Proposal, "missBeforeM" | "missAfterM" | "fuelKg" | "burnAt"> & { leadH: number; crossDeg: number }): Proposal {
  const craft = p.mover === "a" ? CRAFT_A : CRAFT_B;
  return {
    version: p.version,
    mover: p.mover,
    action: p.action,
    burnAt: p.action === "wait" ? null : e.tca - p.leadH * 3600_000,
    dvMs: p.dvMs,
    fuelKg: p.action === "wait" ? 0 : fuelG(craft, p.dvMs) / 1000,
    missBeforeM: e.missM,
    missAfterM: p.action === "wait" ? e.missM : missAfter(e, p.crossDeg, p.dvMs, p.leadH),
    rationale: p.rationale,
    reason: p.reason,
  };
}

/* ------------------------------------------------------------ building blocks */

async function redEvent(
  eng: Engine,
  gen: number,
  opts: { salt: number; crossDeg: number; missM: number; pc: number; tcaInH: number; bName: string; bOperator: string; bOwner: string; debris?: boolean },
  existing?: ConjunctionEvent,
) {
  if (existing) {
    // picked from scan results: the pass already ran, go straight to the agents
    useOps.setState({ focusEvent: existing.id });
    await eng.sleep(900, gen);
    eng.update(existing.id, { risk: "red", status: "agents", agentsWorking: true });
    eng.log("monitor", `${existing.id} selected by the dispatcher · Pc ${fmtPc(existing.pc)} · waking agents`, "warn", { eventId: existing.id });
    await eng.span({ agent: "monitor", target: "analyst", kind: "handoff", name: `Wake Incident Analyst · ${existing.id}`, eventId: existing.id }, 380, gen);
    return eng.event(existing.id)!;
  }
  const a = pickObject((o) => o.category === "starlink", opts.salt) ?? pickObject((o) => o.category === "other", opts.salt);
  if (!a) throw new Error("Catalog not loaded");
  const e = makeEvent(eng, {
    a,
    aOperator: a.category === "starlink" ? "SpaceX Starlink" : a.owner,
    b: {
      norad: 90_000 + 700 + opts.salt,
      name: opts.bName,
      owner: opts.bOwner,
      operator: opts.bOperator,
      kind: opts.debris ? "debris" : "payload",
    },
    tcaInH: opts.tcaInH,
    missM: opts.missM,
    crossDeg: opts.crossDeg,
    pc: opts.pc,
    risk: "yellow",
    trend: "rising",
    pcSource: "SOCRATES + CDM",
  });
  if (!e) throw new Error("Could not build the encounter");
  eng.log("system", `${e.id} entered the queue · ${e.a.name} × ${e.b.name} · ${fmtMiss(e.missM)}`, "info", { eventId: e.id });
  useOps.setState({ focusEvent: e.id });
  await eng.sleep(1600, gen);
  await screeningPass(eng, gen, { eventId: e.id });
  eng.update(e.id, { risk: "red", status: "agents", agentsWorking: true });
  eng.log("monitor", `${e.id} turned red · Pc ${fmtPc(e.pc)} > 1e-4 and TCA < 72 h · waking agents`, "warn", { eventId: e.id });
  await eng.span({ agent: "monitor", target: "analyst", kind: "handoff", name: `Wake Incident Analyst · ${e.id}`, eventId: e.id }, 380, gen);
  return eng.event(e.id)!;
}

async function analyze(eng: Engine, gen: number, e: ConjunctionEvent, crossDeg: number) {
  const id = e.id;
  const root = await eng.span(
    {
      agent: "analyst",
      target: "celestrak",
      kind: "http",
      name: `GP element sets · ${e.a.norad}`,
      eventId: id,
      http: { method: "GET", url: `https://celestrak.org/NORAD/elements/gp.php?CATNR=${e.a.norad}&FORMAT=json`, bytes: 712 },
      output: { epoch_age_h: 14.6, source: "18 SDS" },
    },
    540,
    gen,
  );
  await Promise.all([
    eng.span(
      {
        agent: "analyst",
        target: "celestrak",
        kind: "http",
        name: "Operator ephemeris (SupGP)",
        eventId: id,
        parent: root.id,
        http: { method: "GET", url: `https://celestrak.org/NORAD/elements/supplemental/ · CATNR=${e.a.norad}` },
        output: { found: true, source: "operator-supplied" },
      },
      760,
      gen,
    ),
    eng.span(
      {
        agent: "analyst",
        target: "keeptrack",
        kind: "http",
        name: "Owner, purpose, contacts",
        eventId: id,
        parent: root.id,
        http: { method: "GET", url: `KeepTrack API v4 · satellite ${e.a.norad}` },
        output: { a: { operator: e.a.operator, purpose: "Communications" }, b: { operator: e.b.operator, purpose: e.b.kind === "debris" ? "—" : "Earth observation" } },
      },
      680,
      gen,
    ),
  ]);
  await eng.span(
    {
      agent: "analyst",
      target: "sgp4",
      kind: "tool",
      name: "compute_conjunction(GP, SupGP)",
      eventId: id,
      parent: root.id,
      input: { a: e.a.norad, b: e.b.norad, window_h: 2, step_s: 1 },
      output: {
        tca: new Date(e.tca).toISOString(),
        miss_m_gp: e.missM,
        miss_m_supgp: e.missM + e.uncertaintyM,
        uncertainty_m: e.uncertaintyM,
        radial_m: e.radialM,
        rel_velocity_kms: +e.relVelKms.toFixed(2),
        crossing_deg: crossDeg,
      },
    },
    1150,
    gen,
  );
  // short sentences; names are turned into object links by the UI, numbers set in mono
  const summary = [
    `${e.a.name} and ${e.b.name} pass ${fmtMiss(e.missM)} apart on ${fmtWhen(e.tca)}.`,
    `Chance of collision ${fmtOdds(e.pc)} (${e.pcSource}), rising for 24 h. They cross at ${crossDeg}° and ${e.relVelKms.toFixed(1)} km/s.`,
    `US orbit data says ${fmtMiss(e.missM)}, the operator's says ${fmtMiss(e.missM + e.uncertaintyM)}. Uncertainty ±${fmtMiss(e.uncertaintyM)}.`,
    `${Math.abs(Math.round(e.where.lat))}°${e.where.lat >= 0 ? "N" : "S"} ${Math.abs(Math.round(e.where.lon))}°${e.where.lon >= 0 ? "E" : "W"}, ${Math.round(e.where.altKm)} km up.`,
    e.b.kind === "debris" ? `${e.a.name} raises, lowers, or waits for the next CDM. Debris can't move.` : `${e.a.name} raises, ${e.b.name} lowers, or both wait for the next CDM.`,
  ];
  await eng.span(
    {
      agent: "analyst",
      target: "convex",
      kind: "llm",
      name: "Five-line summary + options",
      eventId: id,
      parent: root.id,
      tokensIn: 11_420,
      tokensOut: 742,
      cacheRead: 8_960,
      reasoning: `Both element sets are fresh (A's epoch is under a day old). The GP and SupGP solutions disagree by ${fmtMiss(e.uncertaintyM)}${e.uncertaintyM >= e.missM ? ", more than the miss itself, so the two objects may be closer than either solution says" : `, about ${Math.round((e.uncertaintyM / e.missM) * 100)}% of the miss, so the encounter can't be ruled out on data quality`}. The chance of collision, ${fmtOdds(e.pc)}, is above the 1 in 10,000 action line. The geometry is a ${crossDeg}° crossing, so an along-track phasing burn is efficient: a small Δv ahead of time shifts the arrival time and opens the miss perpendicular to the relative velocity. I'll give three options in the fixed set (raise, lower, wait) and leave the choice to the advocates.`,
      output: { summary, options: e.b.kind === "debris" ? ["A raise", "A lower", "wait"] : ["A raise", "B lower", "wait"] },
    },
    3400,
    gen,
  );
  eng.update(id, { summary });
}

async function negotiate(
  eng: Engine,
  gen: number,
  e: ConjunctionEvent,
  p: { first: Proposal; constraintB?: string; rounds?: { from: "advocateA" | "advocateB"; text: string }[] },
) {
  const id = e.id;
  await Promise.all([
    eng.span({ agent: "analyst", target: "advocateA", kind: "handoff", name: "Brief Advocate A", eventId: id }, 300, gen),
    eng.span({ agent: "analyst", target: "advocateB", kind: "handoff", name: "Brief Advocate B", eventId: id }, 300, gen),
  ]);
  await Promise.all([
    (async () => {
      await eng.span(
        {
          agent: "advocateA",
          target: "policy",
          kind: "tool",
          name: "read_policy(operator A)",
          eventId: id,
          output: { min_fuel_reserve_pct: 25, fuel_reserve_pct: CRAFT_A.fuelReservePct, acceptable_pc: 1e-4, no_move_windows: [], prefers: "move early, small Δv" },
        },
        260,
        gen,
      );
      await eng.span(
        {
          agent: "advocateA",
          target: "sgp4",
          kind: "tool",
          name: "evaluate_options",
          eventId: id,
          input: { burns: ["A +0.05 m/s @ TCA−6h", "B −0.08 m/s @ TCA−8h"] },
          output: { "A raise": `→ ${fmtMiss(missAfter(e, crossOf(e), 0.05, 6))}`, "B lower": `→ ${fmtMiss(missAfter(e, crossOf(e), 0.08, 8))}` },
        },
        900,
        gen,
      );
    })(),
    (async () => {
      await eng.span(
        {
          agent: "advocateB",
          target: "policy",
          kind: "tool",
          name: "read_policy(operator B)",
          eventId: id,
          output: {
            min_fuel_reserve_pct: 15,
            fuel_reserve_pct: CRAFT_B.fuelReservePct,
            acceptable_pc: 1e-4,
            no_move_windows: p.constraintB ? [p.constraintB] : [],
            prefers: "the other side moves",
          },
        },
        300,
        gen,
      );
      await eng.span(
        {
          agent: "advocateB",
          target: "sgp4",
          kind: "tool",
          name: "evaluate_options",
          eventId: id,
          input: { burns: ["B −0.08 m/s @ TCA−8h"] },
          output: { "B lower": `→ ${fmtMiss(missAfter(e, crossOf(e), 0.08, 8))}`, fuel_after_pct: CRAFT_B.fuelReservePct - 0.4 },
        },
        760,
        gen,
      );
    })(),
  ]);
  const rounds = p.rounds ?? [
    { from: "advocateA" as const, text: `Offer: B lowers ${p.first.dvMs} m/s. B's thruster is chemical and the burn costs ${(p.first.fuelKg * 1000).toFixed(1)} g, well inside B's reserve.` },
    { from: "advocateB" as const, text: "Accept within policy: B stays above its 15% fuel floor and no mission window is touched." },
  ];
  for (const r of rounds) {
    const to = r.from === "advocateA" ? "advocateB" : "advocateA";
    await eng.span(
      {
        agent: r.from,
        target: to,
        kind: "llm",
        name: r.text.split(":")[0],
        eventId: id,
        tokensIn: 4_900 + Math.round(Math.random() * 900),
        tokensOut: 260 + Math.round(Math.random() * 120),
        cacheRead: 3_800,
        reasoning: r.text,
        output: { message: r.text },
      },
      2300,
      gen,
    );
  }
}

async function check(eng: Engine, gen: number, e: ConjunctionEvent, pr: Proposal, disagree = false) {
  const id = e.id;
  const claimed = disagree ? pr.missAfterM * 1.12 : pr.missAfterM;
  const ok = !disagree;
  await eng.span(
    {
      agent: "analyst",
      target: "sgp4",
      kind: "check",
      name: "Numbers check (deterministic)",
      eventId: id,
      input: { rationale_miss_after_m: Math.round(claimed), dv_ms: pr.dvMs, burn_at: pr.burnAt && new Date(pr.burnAt).toISOString() },
      output: ok ? { recomputed_miss_after_m: Math.round(pr.missAfterM), match: true } : { recomputed_miss_after_m: Math.round(pr.missAfterM), match: false, diff_m: Math.round(claimed - pr.missAfterM) },
      fail: ok ? undefined : `Rationale says ${fmtMiss(claimed)}, SGP4 says ${fmtMiss(pr.missAfterM)}`,
    },
    420,
    gen,
  );
  await eng.span(
    {
      agent: "checker",
      target: "analyst",
      kind: "llm",
      name: ok ? "Second opinion · agrees" : "Second opinion · disagrees",
      eventId: id,
      tokensIn: 3_100,
      tokensOut: 190,
      reasoning: ok
        ? `Read the proposal and the numbers independently. ${pr.mover === "a" ? "A" : "B"} ${pr.action}s ${pr.dvMs} m/s at ${pr.burnAt ? fmtWhen(pr.burnAt) : "—"}; the miss goes from ${fmtMiss(pr.missBeforeM)} to ${fmtMiss(pr.missAfterM)}. The explanation matches the numbers and does not overstate the risk. Agree.`
        : `The rationale claims a ${fmtMiss(claimed)} miss after the burn, but the attached screening output says ${fmtMiss(pr.missAfterM)}. The conclusion still holds, but the text overstates the benefit by ${fmtMiss(claimed - pr.missAfterM)}. Flagging to the humans and sending it back for a rewrite.`,
      output: { agrees: ok },
      fail: ok ? undefined : "Disagreement flagged to both operators",
    },
    1700,
    gen,
  );
  if (!ok) {
    eng.log("checker", "Rationale sent back: number in the text does not match SGP4", "warn", { eventId: id });
    await eng.span(
      {
        agent: "analyst",
        target: "convex",
        kind: "llm",
        name: "Rewrite rationale from tool output",
        eventId: id,
        tokensIn: 5_200,
        tokensOut: 310,
        cacheRead: 4_400,
        reasoning: `Regenerating the explanation with every number copied from the screening output instead of restated: miss after ${fmtMiss(pr.missAfterM)}, Δv ${pr.dvMs} m/s, fuel ${(pr.fuelKg * 1000).toFixed(1)} g.`,
      },
      1500,
      gen,
    );
    await eng.span(
      { agent: "analyst", target: "sgp4", kind: "check", name: "Numbers check (deterministic)", eventId: id, output: { match: true } },
      380,
      gen,
    );
  }
}

/**
 * Up to four plan cards from the fixed set (raise, lower, wait). The current proposal is always one of them
 * with its exact numbers; `pick` (the agents' own choice) is marked recommended, so a plan a person selected
 * never reads as the agents' (spec §2.3 `recommendedBy`, §4.1).
 */
function optionsFor(e: ConjunctionEvent, pr: Proposal, pick: { mover: "a" | "b" | "none"; action: "raise" | "lower" | "wait" }): DecisionOption[] {
  const debris = e.b.kind === "debris";
  const dv = pr.dvMs || 0.05;
  const shapes: { mover: "a" | "b" | "none"; action: "raise" | "lower" | "wait"; leadH: number }[] = debris
    ? [
        { mover: "a", action: "raise", leadH: 6 },
        { mover: "a", action: "lower", leadH: 6 },
        { mover: "a", action: "raise", leadH: 3 },
        { mover: "none", action: "wait", leadH: 0 },
      ]
    : [
        { mover: "a", action: "raise", leadH: 6 },
        { mover: "b", action: "lower", leadH: 8 },
        { mover: "a", action: "lower", leadH: 6 },
        { mover: "none", action: "wait", leadH: 0 },
      ];
  const out: DecisionOption[] = shapes.map((sh) => {
    const p = proposal(e, { version: 0, mover: sh.mover, action: sh.action, dvMs: sh.action === "wait" ? 0 : dv, leadH: sh.leadH, crossDeg: crossOf(e), rationale: "" });
    const g = (p.fuelKg * 1000).toFixed(1);
    const why =
      sh.action === "wait"
        ? `No burn. The chance stays ${fmtOdds(e.pc)} until the next CDM.`
        : sh.mover === "b"
          ? `Uses B's chemical thruster: ${g} g, B has ${CRAFT_B.fuelReservePct}% fuel left.`
          : sh.leadH < 6
            ? `Burn later, at TCA−${sh.leadH} h: less margin, same fuel.`
            : sh.action === "lower"
              ? `Same cost as raising (${g} g); ends below the original shell.`
              : `Uses A's electric thruster: ${g} g of krypton.`;
    return { id: `${sh.mover}-${sh.action}-${sh.leadH}`, mover: p.mover, action: p.action, dvMs: p.dvMs, burnAt: p.burnAt, fuelKg: p.fuelKg, missAfterM: p.missAfterM, recommended: false, why };
  });
  // the current proposal replaces the card with the same move, with its exact numbers and reasoning
  const cur = out.findIndex((o) => o.mover === pr.mover && o.action === pr.action);
  const live: DecisionOption = { id: cur >= 0 ? out[cur].id : `${pr.mover}-${pr.action}-v${pr.version}`, mover: pr.mover, action: pr.action, dvMs: pr.dvMs, burnAt: pr.burnAt, fuelKg: pr.fuelKg, missAfterM: pr.missAfterM, recommended: false, why: pr.rationale };
  if (cur >= 0) out[cur] = live;
  else out[out.length - 2] = live;
  for (const o of out) o.recommended = o.mover === pick.mover && o.action === pick.action;
  // the agents' pick first, the rest in a fixed order so card labels stay put between revisions
  return out.sort((x, y) => Number(y.recommended) - Number(x.recommended));
}

/** Publish a revision: it becomes the shared selection and every required approval resets (ROOM-11). */
async function openRoom(eng: Engine, gen: number, e: ConjunctionEvent, pr: Proposal, by: "a" | "b" | "agents" = "agents") {
  const id = e.id;
  const prev = eng.event(id);
  // the agents' pick changes only when the agents revise, never because a person selected a plan
  const pick = by === "agents" || !prev?.agentPick ? { mover: pr.mover, action: pr.action } : prev.agentPick;
  const options = optionsFor(e, pr, pick);
  const selected = options.find((o) => o.mover === pr.mover && o.action === pr.action)!;
  const label = `P${options.indexOf(selected) + 1}`;
  const revision = (prev?.proposals ?? []).filter((x) => x.mover === pr.mover && x.action === pr.action && x.version !== pr.version).length + 1;
  eng.update(id, (ev) => ({
    proposals: [...(ev.proposals ?? []).filter((x) => x.version !== pr.version), { ...pr, publishedAt: Date.now(), label, revision, by }],
  }));
  eng.update(id, (ev) => ({
    proposal: pr,
    options,
    agentPick: pick,
    selection: { optionId: selected.id, generation: (ev.selection?.generation ?? 0) + 1, by, at: Date.now() },
    lastReset: pr.version > 1 ? { at: Date.now(), reason: `${label} · R${revision} ${by === "agents" ? "created by the agents" : "selected for review"}, ${e.b.kind === "debris" ? "approval reset" : "both approvals reset"}` } : ev.lastReset,
    status: "proposal",
    approvals: { a: "pending", b: e.b.kind === "debris" ? "approved" : "pending" },
  }));
  await eng.span({ agent: "analyst", target: "host", kind: "handoff", name: `Proposal v${pr.version} ready`, eventId: id }, 300, gen);
  await eng.span({ agent: "host", target: "room", kind: "tool", name: "open_room", eventId: id, output: { room: `room_${id.toLowerCase()}`, languages: ["en", "ru"] } }, 420, gen);
  await eng.span(
    {
      agent: "host",
      target: "keeptrack",
      kind: "http",
      name: "Resolve operator contacts",
      eventId: id,
      http: { method: "GET", url: "KeepTrack API v4 · operators" },
      output: { a: "on-call dispatcher, in-app", b: e.b.kind === "debris" ? "none (debris)" : "on-call dispatcher, in-app" },
    },
    520,
    gen,
  );
  eng.update(id, { status: "communication", agentsWorking: false });
  const calls = [eng.span({ agent: "host", target: "humanA", kind: "human", name: "Call Operator A", eventId: id, model: "grok-voice" }, 1400, gen)];
  if (e.b.kind !== "debris") calls.push(eng.span({ agent: "host", target: "humanB", kind: "human", name: "Call Operator B", eventId: id, model: "grok-voice" }, 1900, gen));
  await Promise.all(calls);
}

async function askHumans(eng: Engine, gen: number, e: ConjunctionEvent, pr: Proposal, autoA: Decision, autoB: Decision) {
  const asks = [eng.human(e.id, "a", pr.version, autoA, gen)];
  if (e.b.kind !== "debris") asks.push(eng.human(e.id, "b", pr.version, autoB, gen));
  const [a, b] = await Promise.all(asks);
  return { a, b: b ?? { decision: "approved" as const } };
}

/** Hard "no" a side has stated in the room: the simulated operator keeps it in every later round. */
const hardNo = new Map<string, { side: "a" | "b"; note: string; original?: string; lang?: string }>();

const partyName = (e: ConjunctionEvent, side: "a" | "b") =>
  (e.parties?.find((p) => p.role === side)?.operator ?? `Operator ${side.toUpperCase()}`).replace(/\s*\(synthetic\)/i, "");

const planWords = (e: ConjunctionEvent, p: Pick<Proposal, "mover" | "action" | "dvMs">) =>
  p.action === "wait" ? "wait for the next CDM" : `${p.mover === "a" ? e.a.name : e.b.name} ${p.action}s ${p.dvMs} m/s`;

/** Ask both sides until they approve; a veto or counter sends the agents back (AGT-4, ROOM-11). */
async function agree(eng: Engine, gen: number, e: ConjunctionEvent, first: Proposal, autoA: Decision, autoB: Decision, initial?: { a: Decision; b: Decision }): Promise<Proposal | null> {
  let pr = first;
  for (let round = 0; round < 4; round++) {
    // a simulated side that said "no" to moving keeps saying it when a plan moves it again
    const auto = (side: "a" | "b", first: Decision): Decision => {
      const hn = hardNo.get(e.id);
      if (hn && hn.side === side && pr.mover === side) return { decision: "vetoed", note: hn.note, original: hn.original, lang: hn.lang };
      return round === 0 ? first : { decision: "approved" };
    };
    const r = round === 0 && initial ? initial : await askHumans(eng, gen, eng.event(e.id)!, pr, auto("a", autoA), auto("b", autoB));
    const no = r.a.decision !== "approved" ? { side: "A", d: r.a } : r.b.decision !== "approved" ? { side: "B", d: r.b } : null;
    if (!no) return pr;
    eng.update(e.id, { status: "agents", agentsWorking: true, approvals: { a: "pending", b: "pending" } });
    const target = no.side === "A" ? "advocateA" : "advocateB";
    await eng.span(
      { agent: "host", target, kind: "handoff", name: `${no.d.via === "select" ? `${no.d.label ?? "Plan"} selected by` : no.d.decision === "countered" ? "Message from" : "Veto from"} Operator ${no.side}`, eventId: e.id, input: { note: no.d.note ?? "", proposal: pr.version } },
      320,
      gen,
    );
    const later = no.d.decision === "countered" && !no.d.preferred;
    const swap = !later && pr.mover !== "none";
    const pref = no.d.preferred;
    const next = pref
      ? proposal(eng.event(e.id)!, {
          version: pr.version + 1,
          mover: pref.mover,
          action: pref.action,
          dvMs: pref.action === "wait" ? 0 : pr.dvMs || 0.05,
          leadH: pref.action === "wait" ? 0 : pref.mover === "b" ? 8 : 6,
          crossDeg: crossOf(e),
          rationale: `${partyName(e, no.side === "A" ? "a" : "b")} selected “${planWords(e, { mover: pref.mover, action: pref.action, dvMs: pref.action === "wait" ? 0 : pr.dvMs || 0.05 })}” for review instead of “${planWords(e, pr)}”${no.d.note ? ` and said: “${no.d.note}”` : ""}. SGP4 recomputed it before it went back to both sides. Selecting is not approving: both sides approve it again.`,
          reason: `${partyName(e, no.side === "A" ? "a" : "b")} selected ${no.d.label ?? "another plan"} for review`,
        })
      : proposal(eng.event(e.id)!, {
      version: pr.version + 1,
      mover: swap ? (pr.mover === "a" ? "b" : "a") : pr.mover,
      action: pr.action === "wait" ? "raise" : pr.action,
      dvMs: later ? +(pr.dvMs * 1.25).toFixed(3) : pr.dvMs,
      leadH: later ? Math.max(((pr.burnAt ? e.tca - pr.burnAt : 6 * 3600_000) / 3600_000) - 2, 2) : 6,
      crossDeg: crossOf(e),
      rationale: later
        ? `${partyName(e, no.side === "A" ? "a" : "b")} asked for a later burn${no.d.note ? ` (“${no.d.note}”)` : ""}. The burn moves 2 h later and Δv goes up to keep the same miss.`
        : `${partyName(e, no.side === "A" ? "a" : "b")} rejected “${planWords(e, pr)}”${no.d.note ? ` because “${no.d.note}”` : ""}. The other satellite moves instead.`,
      reason: `${partyName(e, no.side === "A" ? "a" : "b")} ${no.d.decision === "vetoed" ? "rejected" : "countered"} v${pr.version}${no.d.note ? `: “${no.d.note}”` : ""}`,
        });
    await eng.span(
      {
        agent: target,
        target: target === "advocateA" ? "advocateB" : "advocateA",
        kind: "llm",
        name: "Revise after human input",
        eventId: e.id,
        tokensIn: 5_600,
        tokensOut: 340,
        cacheRead: 4_100,
        reasoning: `Operator ${no.side} said “${no.d.note ?? no.d.decision}”. Treating it as a hard constraint for this incident, not a policy change. Recomputing with SGP4: ${fmtMiss(next.missBeforeM)} → ${fmtMiss(next.missAfterM)}. Earlier approvals do not carry over to v${next.version}.`,
      },
      2400,
      gen,
    );
    await check(eng, gen, eng.event(e.id)!, next);
    await openRoom(eng, gen, eng.event(e.id)!, next, pref ? (no.side === "A" ? "a" : "b") : "agents");
    pr = next;
  }
  // four rounds without agreement: hand it to the people, never schedule a rejected plan (AGT-10)
  eng.update(e.id, { status: "needs_decision", agentsWorking: false });
  eng.log("analyst", `${e.id} no plan both sides accept after 4 rounds · needs operator decision`, "warn", { eventId: e.id });
  return null;
}

type Affected = { operator: string; owner: string; satellite: string };

/** Record a step that really ran, for the resolution summary. */
function checkDone(eng: Engine, id: string, label: string, detail: string, ok = true) {
  eng.update(id, (ev) => ({ outcome: { checks: [...(ev.outcome?.checks ?? []), { label, detail, ok }], next: ev.outcome?.next ?? [], resolvedAt: null } }));
}

/** Close the incident: next actions, the time, and the green screen. */
function resolve(eng: Engine, id: string, next: string[]) {
  eng.update(id, (ev) => ({ outcome: { checks: ev.outcome?.checks ?? [], next, resolvedAt: Date.now() } }));
  useOps.setState((s) => ({ resolved: { eventId: id, at: Date.now() }, alert: s.alert?.eventId === id ? null : s.alert }));
}

async function scheduleAndVerify(eng: Engine, gen: number, e: ConjunctionEvent, pr: Proposal, refuse = false, affected?: Affected) {
  const id = e.id;
  if (pr.action === "wait") {
    // both sides agreed to wait: nothing to schedule, keep watching (ROOM-2)
    eng.update(id, { status: "monitoring", agentsWorking: false });
    eng.log("host", `${id} both sides agreed to wait · monitoring until the next CDM`, "info", { eventId: id });
    checkDone(eng, id, "Both sides agreed to wait", `No burn. A ${fmtOdds(e.pc)} chance stays under watch`);
    resolve(eng, id, [`Risk Monitor re-checks ${id} with every new CDM until ${fmtWhen(e.tca)}`, "Either side can reopen the room from the inbox", "Decision and both answers are in the audit log"]);
    return true;
  }
  eng.update(id, { status: "approved", agentsWorking: true });
  await eng.span({ agent: "host", target: "scheduler", kind: "handoff", name: "Two approvals · schedule", eventId: id }, 320, gen);
  await eng.span(
    {
      agent: "scheduler",
      target: "sgp4",
      kind: "tool",
      name: "rescreen(moved satellite, full catalog)",
      eventId: id,
      input: { norad: pr.mover === "a" ? e.a.norad : e.b.norad, dv_ms: pr.dvMs, burn_at: pr.burnAt && new Date(pr.burnAt).toISOString(), horizon_h: 72 },
      output: refuse ? { new_conjunctions: [{ with: "SL-DEB 48871 (SYN)", miss_m: 410, tca_offset_h: 19 }] } : { new_conjunctions: [] },
      fail: refuse ? "New conjunction after the burn: 410 m with SL-DEB 48871 (SYN)" : undefined,
    },
    2600,
    gen,
  );
  if (refuse) return false;
  const moverName = pr.mover === "a" ? e.a.name : e.b.name;
  checkDone(eng, id, "Catalog re-screen", "Moved orbit checked against all 18,589 objects: no new conjunctions in 72 h");
  await eng.span(
    {
      agent: "scheduler",
      target: "schedule",
      kind: "tool",
      name: "write_maneuver_file",
      eventId: id,
      input: { path: `schedule/${pr.mover === "a" ? "operator-a" : "operator-b"}/${id}.json` },
      output: { written: true, diff: `+ burn ${pr.burnAt && new Date(pr.burnAt).toISOString()} Δv ${pr.dvMs} m/s along-track` },
    },
    480,
    gen,
  );
  if (affected) {
    // the new path passes near a third operator's satellite: tell them before the burn (DSP-3, DSP-6)
    eng.update(id, (ev) => ({ parties: [...(ev.parties ?? []), partyOf("humanC", "affected", affected.operator, affected.owner)] }));
    eng.log("scheduler", `New path passes 9.4 km from ${affected.satellite} (${affected.operator}) · notice required before the burn`, "warn", { eventId: id });
    await eng.span(
      {
        agent: "host",
        target: "humanC",
        kind: "human",
        name: "Notify affected operator",
        eventId: id,
        model: "grok-voice",
        input: { operator: affected.operator, satellite: affected.satellite, closest_after_burn_km: 9.4 },
        output: { delivered: "inbox + in-app notice", acknowledged: true },
      },
      1600,
      gen,
    );
  }
  checkDone(eng, id, "Maneuver scheduled", `${moverName} ${pr.action}s ${pr.dvMs} m/s at ${pr.burnAt ? fmtWhen(pr.burnAt) : "—"}`);
  if (affected) checkDone(eng, id, "Affected operator notified", `${affected.operator.replace(/\s*\(synthetic\)/i, "")} acknowledged before the burn`);
  eng.update(id, { status: "scheduled", agentsWorking: false });
  eng.log("scheduler", `${id} scheduled · checked against the catalog, no new conjunctions`, "info", { eventId: id });
  // jump ahead: the verifier runs after the burn time on fresh orbit data
  await eng.sleep(2600, gen);
  eng.update(id, { status: "awaiting_verification", agentsWorking: true });
  await eng.span(
    {
      agent: "verifier",
      target: "celestrak",
      kind: "http",
      name: "New element set after the burn",
      eventId: id,
      http: { method: "GET", url: `https://celestrak.org/NORAD/elements/gp.php?CATNR=${pr.mover === "a" ? e.a.norad : e.b.norad}&FORMAT=json` },
      output: { epoch: "after burn + 5.2 h", mean_motion_change: "consistent with +0.05 m/s" },
    },
    700,
    gen,
  );
  await eng.span(
    {
      agent: "verifier",
      target: "sgp4",
      kind: "llm",
      name: "Compare promised vs observed",
      eventId: id,
      tokensIn: 3_800,
      tokensOut: 220,
      cacheRead: 2_900,
      reasoning: `The new element set shows the semi-major axis change a ${pr.dvMs} m/s along-track burn should produce, within the element-set noise. Re-propagated miss at TCA is ${fmtMiss(pr.missAfterM)}, as promised. Marking the maneuver confirmed.`,
      output: { verified: true },
    },
    1600,
    gen,
  );
  eng.update(id, { status: "verified", agentsWorking: false });
  checkDone(eng, id, "Burn verified", `New element set matches the promise: miss at TCA ${fmtMiss(pr.missAfterM)}`);
  resolve(eng, id, [
    `Verifier re-checks with the next element set before ${fmtWhen(e.tca)}`,
    `Risk Monitor keeps ${id} in the feed until TCA passes`,
    "Both operators get the record in their inbox and the audit log",
  ]);
  eng.log("verifier", `${id} maneuver confirmed`, "info", { eventId: id });
  return true;
}

/* ---------------------------------------------------------------- scenarios */

const RU_DAY: Record<string, string> = {
  Sun: "в воскресенье",
  Mon: "в понедельник",
  Tue: "во вторник",
  Wed: "в среду",
  Thu: "в четверг",
  Fri: "в пятницу",
  Sat: "в субботу",
};

const RED_B = { bName: "SEVER-7 (SYN)", bOperator: "Sever Imaging (synthetic)", bOwner: "CIS" };

export const SCENARIOS: Scenario[] = [
  {
    id: "demo",
    title: "Veto, then re-plan",
    story: "B can't move during an imaging pass. One “no” sends the agents back; A moves instead.",
    refs: "plan-v1 §7 · AGT-4, ROOM-11",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 64;
      const e = await redEvent(eng, gen, { salt: 2, crossDeg: cross, missM: 180, pc: 3.1e-4, tcaInH: 31, ...RED_B }, existing);
      await analyze(eng, gen, e, cross);
      const v1 = proposal(e, { version: 1, mover: "b", action: "lower", dvMs: 0.08, leadH: 8, crossDeg: cross, rationale: "B lowers: cheapest for B's chemical thruster, no policy rule blocks it." });
      await negotiate(eng, gen, e, { first: v1 });
      await check(eng, gen, e, v1);
      await openRoom(eng, gen, e, v1);
      const day = fmtWhen(v1.burnAt!).split(" ")[0];
      const ru = `У меня съёмка ${RU_DAY[day] ?? day}, двигаться не могу`;
      const r1 = await askHumans(eng, gen, e, v1, { decision: "approved" }, { decision: "vetoed", note: `imaging pass on ${day}, I can't move`, original: ru, lang: "Russian" });
      if (r1.b.decision !== "approved") hardNo.set(e.id, { side: "b", note: `imaging pass on ${day}, I can't move`, original: ru, lang: "Russian" });
      if (r1.a.decision !== "approved") {
        // the dispatcher chose differently: the generic revision path takes over
        const fin = await agree(eng, gen, e, v1, { decision: "approved" }, { decision: "approved" }, r1);
        if (fin) await scheduleAndVerify(eng, gen, e, fin);
      } else if (r1.b.decision !== "approved") {
        eng.log("host", `Translated from Russian: “${ru}” → “imaging pass on ${day}, I can't move”`, "info", { eventId: e.id });
        eng.update(e.id, { status: "agents", agentsWorking: true, approvals: { a: "pending", b: "pending" } });
        await eng.span({ agent: "host", target: "advocateB", kind: "handoff", name: "New hard constraint from B", eventId: e.id, input: { constraint: `no burn on ${day} (imaging)`, source: "room message, voice" } }, 300, gen);
        const v2 = proposal(e, { version: 2, mover: "a", action: "raise", dvMs: 0.05, leadH: 6, crossDeg: cross, rationale: `${partyName(e, "b")} can't move ${e.b.name}: an imaging pass on ${day} is a hard no-move window. ${e.a.name} has ${CRAFT_A.fuelReservePct}% fuel and an electric thruster, so it moves instead.`, reason: `${partyName(e, "b")} rejected v1: imaging pass on ${day}` });
        await negotiate(eng, gen, e, {
          first: v2,
          constraintB: `${day} imaging pass`,
          rounds: [
            { from: "advocateB", text: `Constraint: no burn on ${day}, imaging pass. This is a hard rule, not a preference.` },
            { from: "advocateA", text: `Counter: A raises ${v2.dvMs} m/s at TCA−6 h. ${(v2.fuelKg * 1000).toFixed(1)} g of krypton, reserve stays at ${CRAFT_A.fuelReservePct}%. Miss ${fmtMiss(v2.missBeforeM)} → ${fmtMiss(v2.missAfterM)}.` },
            { from: "advocateB", text: "Accept: B does not move and keeps its window." },
          ],
        });
        await check(eng, gen, e, v2);
        await openRoom(eng, gen, e, v2);
        const fin = await agree(eng, gen, e, v2, { decision: "approved" }, { decision: "approved" });
        if (fin) await scheduleAndVerify(eng, gen, e, fin, false, { operator: "Hoshi Imaging (synthetic)", owner: "JPN", satellite: "HOSHI-3 (SYN)" });
      } else {
        await scheduleAndVerify(eng, gen, e, v1);
      }
    },
  },
  {
    id: "happy",
    title: "Both approve",
    story: "A red event turns into a ready proposal in under a minute; both owners approve.",
    refs: "plan-v1 §6 user flow · Q-3, ROOM-2",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 72;
      const e = await redEvent(eng, gen, { salt: 7, crossDeg: cross, missM: 240, pc: 2.2e-4, tcaInH: 44, ...RED_B, bName: "ORLAN-2 (SYN)" }, existing);
      await analyze(eng, gen, e, cross);
      const v1 = proposal(e, { version: 1, mover: "a", action: "raise", dvMs: 0.06, leadH: 7, crossDeg: cross, rationale: "A raises: electric propulsion, large reserve, no mission window affected." });
      await negotiate(eng, gen, e, {
        first: v1,
        rounds: [
          { from: "advocateA", text: `Offer: A raises ${v1.dvMs} m/s at TCA−7 h. ${(v1.fuelKg * 1000).toFixed(1)} g, inside policy.` },
          { from: "advocateB", text: "Accept: B keeps its schedule." },
        ],
      });
      await check(eng, gen, e, v1);
      await openRoom(eng, gen, e, v1);
      const fin = await agree(eng, gen, e, v1, { decision: "approved" }, { decision: "approved" });
      if (fin) await scheduleAndVerify(eng, gen, e, fin);
    },
  },
  {
    id: "refusal",
    title: "Scheduler refuses",
    story: "The approved burn would create a new conjunction. The scheduler refuses and the agents pick “lower”.",
    refs: "EXE-2, EXE-3",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 58;
      const e = await redEvent(eng, gen, { salt: 13, crossDeg: cross, missM: 150, pc: 4.4e-4, tcaInH: 27, ...RED_B, bName: "LUCH-12 (SYN)" }, existing);
      await analyze(eng, gen, e, cross);
      const v1 = proposal(e, { version: 1, mover: "a", action: "raise", dvMs: 0.05, leadH: 6, crossDeg: cross, rationale: "A raises: cheapest option overall." });
      await negotiate(eng, gen, e, { first: v1, rounds: [{ from: "advocateA", text: `Offer: A raises ${v1.dvMs} m/s.` }, { from: "advocateB", text: "Accept." }] });
      await check(eng, gen, e, v1);
      await openRoom(eng, gen, e, v1);
      const fin1 = await agree(eng, gen, e, v1, { decision: "approved" }, { decision: "approved" });
      const ok = fin1 ? await scheduleAndVerify(eng, gen, e, fin1, true) : true;
      if (!ok) {
        eng.log("scheduler", "Refused: the burn creates a 410 m conjunction in 19 h. Back to the agents with that as a constraint.", "error", { eventId: e.id });
        eng.update(e.id, { status: "agents", agentsWorking: true, approvals: { a: "pending", b: "pending" } });
        await eng.span({ agent: "scheduler", target: "advocateA", kind: "handoff", name: "Refusal · new constraint", eventId: e.id, input: { constraint: "no raise: conflicts with SL-DEB 48871 (SYN)" } }, 320, gen);
        const v2 = proposal(e, { version: 2, mover: "a", action: "lower", dvMs: 0.05, leadH: 6, crossDeg: cross, rationale: "A lowers instead: same Δv, and the lower path is clear of the catalog.", reason: "Maneuver Scheduler refusal" });
        await negotiate(eng, gen, e, { first: v2, rounds: [{ from: "advocateA", text: `Counter: A lowers ${v2.dvMs} m/s instead, re-screened clear.` }, { from: "advocateB", text: "Accept." }] });
        await check(eng, gen, e, v2);
        await openRoom(eng, gen, e, v2);
        const fin = await agree(eng, gen, e, v2, { decision: "approved" }, { decision: "approved" });
        if (fin) await scheduleAndVerify(eng, gen, e, fin, false, { operator: "Hoshi Imaging (synthetic)", owner: "JPN", satellite: "HOSHI-3 (SYN)" });
      }
    },
  },
  {
    id: "checker",
    title: "Second opinion disagrees",
    story: "Grok catches a number in the rationale that doesn't match SGP4. The text is rewritten before anyone sees it.",
    refs: "AGT-5, AGT-6",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 80;
      const e = await redEvent(eng, gen, { salt: 19, crossDeg: cross, missM: 210, pc: 1.9e-4, tcaInH: 36, ...RED_B, bName: "KANOPUS-V9 (SYN)" }, existing);
      await analyze(eng, gen, e, cross);
      const v1 = proposal(e, { version: 1, mover: "a", action: "raise", dvMs: 0.07, leadH: 6, crossDeg: cross, rationale: "A raises: B is near its fuel floor." });
      await negotiate(eng, gen, e, { first: v1, rounds: [{ from: "advocateA", text: `Offer: A raises ${v1.dvMs} m/s.` }, { from: "advocateB", text: "Accept: B is at 18% fuel." }] });
      await check(eng, gen, e, v1, true);
      await openRoom(eng, gen, e, v1);
      const fin = await agree(eng, gen, e, v1, { decision: "approved" }, { decision: "approved" });
      if (fin) await scheduleAndVerify(eng, gen, e, fin);
    },
  },
  {
    id: "debris",
    title: "Debris: one side moves",
    story: "A payload against a debris fragment. Debris can't move or answer, so only Operator A decides.",
    refs: "AGT-2 · fixed options",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 104;
      const e = await redEvent(eng, gen, { salt: 23, crossDeg: cross, missM: 120, pc: 6.2e-4, tcaInH: 22, bName: "FENGYUN 1C DEB (SYN)", bOperator: "Debris · no operator", bOwner: "PRC", debris: true }, existing);
      await analyze(eng, gen, e, cross);
      const v1 = proposal(e, { version: 1, mover: "a", action: "raise", dvMs: 0.06, leadH: 5, crossDeg: cross, rationale: "Only A can move. Raise clears the fragment's uncertainty envelope." });
      await eng.span({ agent: "analyst", target: "advocateA", kind: "handoff", name: "Brief Advocate A", eventId: e.id }, 300, gen);
      await eng.span(
        { agent: "advocateA", target: "sgp4", kind: "tool", name: "evaluate_options", eventId: e.id, output: { raise: fmtMiss(v1.missAfterM), lower: fmtMiss(missAfter(e, cross, 0.06, 5) * 0.97), wait: fmtMiss(e.missM) } },
        900,
        gen,
      );
      await eng.span(
        { agent: "advocateA", target: "convex", kind: "llm", name: "Choose: raise", eventId: e.id, tokensIn: 4_300, tokensOut: 280, cacheRead: 3_100, reasoning: `Debris can't negotiate, so this is A's call alone. Raise and lower give nearly the same miss; raise keeps A above the densest debris band. ${(v1.fuelKg * 1000).toFixed(1)} g of fuel.` },
        2100,
        gen,
      );
      await check(eng, gen, e, v1);
      await openRoom(eng, gen, e, v1);
      const fin = await agree(eng, gen, e, v1, { decision: "approved" }, { decision: "approved" });
      if (fin) await scheduleAndVerify(eng, gen, e, fin);
    },
  },
  {
    id: "noagree",
    title: "No agreement",
    story: "Both sides have hard no-move windows. Agents stop, explain why, and leave it to the dispatchers.",
    refs: "AGT-10 · inbox: needs operator decision",
    run: async (eng, gen, existing) => {
      const cross = existing ? crossOf(existing) : 66;
      const e = await redEvent(eng, gen, { salt: 29, crossDeg: cross, missM: 260, pc: 1.4e-4, tcaInH: 18, ...RED_B, bName: "AIST-4 (SYN)" }, existing);
      await analyze(eng, gen, e, cross);
      const day = fmtWhen(e.tca - 6 * 3600_000).split(" ")[0];
      await negotiate(eng, gen, e, {
        first: proposal(e, { version: 1, mover: "none", action: "wait", dvMs: 0, leadH: 0, crossDeg: cross, rationale: "" }),
        constraintB: `${day} downlink window`,
        rounds: [
          { from: "advocateA", text: `Constraint: A is in an orbit-raising campaign until ${day} 12:00 UTC; no extra burns allowed by policy.` },
          { from: "advocateB", text: `Constraint: B has a ${day} downlink window and is below its 15% fuel floor after one more burn.` },
          { from: "advocateA", text: "No option satisfies both hard constraints. Stopping and handing it to the dispatchers." },
        ],
      });
      eng.update(e.id, {
        status: "needs_decision",
        agentsWorking: false,
        proposal: null,
      });
      eng.log("analyst", `${e.id} needs operator decision · conflicting hard constraints shared with both sides`, "warn", { eventId: e.id });
      await eng.span({ agent: "analyst", target: "host", kind: "handoff", name: "No agreement · explain", eventId: e.id }, 300, gen);
      await eng.span({ agent: "host", target: "room", kind: "tool", name: "open_room(no proposal)", eventId: e.id, output: { inbox: ["humanA", "humanB"], reason: "conflicting hard constraints" } }, 420, gen);
    },
  },
];

export function runScenario(id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) return;
  engine.run(id, async (eng, gen) => {
    try {
      await s.run(eng, gen);
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  });
}

/* --------------------------------------------------------------- demo scan */

// What Run scan finds: one case per story, built around real satellites. Priority follows
// Q-1 (Pc over hours to TCA); confidence says how much to trust the numbers and why.
const CANDIDATES: {
  variant: string;
  salt: number;
  pc: number;
  missM: number;
  tcaInH: number;
  crossDeg: number;
  b: { name: string; operator: string; owner: string; debris?: boolean };
  source: ConjunctionEvent["pcSource"];
  confidence: NonNullable<ConjunctionEvent["confidence"]>;
}[] = [
  { variant: "demo", salt: 2, pc: 3.1e-4, missM: 180, tcaInH: 31, crossDeg: 64, b: { name: "SEVER-7 (SYN)", operator: "Sever Imaging (synthetic)", owner: "CIS" }, source: "SOCRATES + CDM", confidence: { level: "high", why: "SOCRATES and a public CDM agree; GP and operator orbits within 103 m" } },
  { variant: "debris", salt: 23, pc: 6.2e-4, missM: 120, tcaInH: 22, crossDeg: 104, b: { name: "FENGYUN 1C DEB (SYN)", operator: "Debris · no operator", owner: "PRC", debris: true }, source: "SOCRATES + CDM", confidence: { level: "high", why: "Listed in both sources; CDM flagged emergency-reportable" } },
  { variant: "refusal", salt: 13, pc: 4.4e-4, missM: 150, tcaInH: 27, crossDeg: 58, b: { name: "LUCH-12 (SYN)", operator: "Sever Imaging (synthetic)", owner: "CIS" }, source: "SOCRATES", confidence: { level: "medium", why: "Only SOCRATES lists it so far; CDM not published yet" } },
  { variant: "checker", salt: 19, pc: 1.9e-4, missM: 210, tcaInH: 36, crossDeg: 80, b: { name: "KANOPUS-V9 (SYN)", operator: "Sever Imaging (synthetic)", owner: "CIS" }, source: "SOCRATES + CDM", confidence: { level: "high", why: "Both sources agree within 40 m" } },
  { variant: "happy", salt: 7, pc: 2.2e-4, missM: 240, tcaInH: 44, crossDeg: 72, b: { name: "ORLAN-2 (SYN)", operator: "Sever Imaging (synthetic)", owner: "CIS" }, source: "CDM", confidence: { level: "medium", why: "CDM only; our screening agrees within 300 m" } },
  { variant: "noagree", salt: 29, pc: 1.4e-4, missM: 260, tcaInH: 18, crossDeg: 66, b: { name: "AIST-4 (SYN)", operator: "Sever Imaging (synthetic)", owner: "CIS" }, source: "SOCRATES", confidence: { level: "low", why: "No operator ephemeris; GP element set is 3 days old" } },
  { variant: "happy", salt: 41, pc: 6.0e-5, missM: 640, tcaInH: 58, crossDeg: 88, b: { name: "TALON-5 (SYN)", operator: "Talon Orbital (synthetic)", owner: "UK" }, source: "SOCRATES", confidence: { level: "medium", why: "Yellow: below the action line, trend flat" } },
];

const variantOf = new Map<string, string>();

/** Run scan: one full screening pass, then the ranked list of what it found. */
export function runScan() {
  engine.run("scan", async (eng, gen) => {
    try {
      useOps.setState({ scan: { phase: "scanning", ids: [], stats: null }, focusEvent: null, actAs: "a" });
      const t0 = Date.now();
      await screeningPass(eng, gen, null);
      const ids: string[] = [];
      for (const c of CANDIDATES) {
        const a = pickObject((o) => o.category === "starlink", c.salt) ?? pickObject((o) => o.category === "other", c.salt);
        if (!a) continue;
        const red = c.pc > 1e-4 && c.tcaInH < 72;
        const e = makeEvent(eng, {
          a,
          aOperator: a.category === "starlink" ? "SpaceX Starlink" : a.owner,
          b: { norad: 90_000 + 800 + c.salt, name: c.b.name, owner: c.b.owner, operator: c.b.operator, kind: c.b.debris ? "debris" : "payload" },
          tcaInH: c.tcaInH,
          missM: c.missM,
          crossDeg: c.crossDeg,
          pc: c.pc,
          risk: red ? "red" : "yellow",
          trend: red ? "rising" : "flat",
          pcSource: c.source,
          confidence: c.confidence,
        });
        if (!e) continue;
        variantOf.set(e.id, c.variant);
        ids.push(e.id);
      }
      const n = useOps.getState().lastScan;
      useOps.setState({
        scan: { phase: "results", ids, stats: { objects: n?.objects ?? 0, pairs: n?.pairs ?? 0, ms: Date.now() - t0 } },
        scenarioDone: true,
      });
      const ranked = useOps.getState().events.filter((e) => ids.includes(e.id) && e.risk === "red");
      ranked.sort((x, y) => y.pc / Math.max((y.tca - Date.now()) / 3600_000, 1) - x.pc / Math.max((x.tca - Date.now()) / 3600_000, 1));
      if (ranked[0]) useOps.setState({ alert: { eventId: ranked[0].id, at: Date.now() } });
      eng.log("monitor", `Scan finished · ${ids.length} candidates · ${ranked.length} red`, ranked.length ? "warn" : "info");
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  });
}

/** The dispatcher picked a case: run its full incident with the camera following. */
export function runIncident(eventId: string) {
  const ev = useOps.getState().events.find((e) => e.id === eventId);
  if (!ev) return;
  const s = SCENARIOS.find((x) => x.id === (variantOf.get(eventId) ?? "happy")) ?? SCENARIOS[1];
  useOps.setState({
    scan: { ...useOps.getState().scan, phase: "idle" },
    actAs: "a",
    focusEvent: eventId,
    agentView: "graph",
    // the alarm did its job; the case view takes over from here
    alert: null,
    incident: eventId,
    incidentView: "expanded",
  });
  engine.runOn(s.id, async (eng, gen) => {
    try {
      await s.run(eng, gen, ev);
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  });
}
