"use client";

import { motion } from "motion/react";
import { Bot, Check, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRealMode } from "@/lib/backend/live";
import {
  backendName,
  isLiveSpan,
  isOther,
  OTHER,
  stageLabel,
  VENDOR_LABEL,
  vendorOf,
  type LiveSpan,
  type Vendor,
} from "@/lib/backend/spans";
import { fmtMs, fmtUsd } from "@/lib/ops/format";
import { AGENTS, HUMANS, MODELS, TOOLS } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import type { AgentId, HumanId, NodeId, Party, Span } from "@/lib/ops/types";
import { Flag } from "@/components/ui/OwnerBadge";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Tooltip } from "@/components/ui/Tooltip";
import { ClaudeGlyph, GrokGlyph, NodeGlyph } from "./Glyphs";
import { EDGE } from "./meta";

// Agent graph: the pipeline from docs/plan-v1.md §5 laid out top to bottom, data
// sources on top, tools at the sides. Edges light up from live spans: a blue pulse
// travels out while a call runs, a green one comes back with the answer.
// Real mode draws backend runs (lib/backend/spans.ts): each run lights its own node, a checker's run its edge to the
// run it checked, and an agent this build does not know gets the generic "other" node.

export const GW = 400;
export const GH = 540;

type GraphId = NodeId | typeof OTHER;

const POS: Record<GraphId, [number, number]> = {
  celestrak: [110, 34],
  socrates: [200, 34],
  spacetrack: [290, 34],
  monitor: [200, 108],
  // only drawn when a span lands on it
  other: [348, 108],
  keeptrack: [52, 190],
  analyst: [200, 190],
  sgp4: [348, 190],
  policy: [52, 272],
  advocateA: [124, 272],
  checker: [200, 272],
  advocateB: [276, 272],
  convex: [348, 272],
  humanA: [52, 354],
  host: [200, 354],
  humanB: [348, 354],
  // affected third operators sit under the deciding pair
  humanC: [118, 408],
  humanD: [282, 408],
  schedule: [52, 488],
  scheduler: [140, 488],
  verifier: [260, 488],
  room: [348, 488],
};

/** Always-visible skeleton: the agent pipeline itself. */
const SKELETON: [NodeId, NodeId][] = [
  ["monitor", "analyst"],
  ["analyst", "advocateA"],
  ["analyst", "advocateB"],
  ["analyst", "checker"],
  ["advocateA", "advocateB"],
  ["analyst", "host"],
  ["host", "scheduler"],
  ["scheduler", "verifier"],
];

/** Orthogonal route with rounded corners, like the reference graph. */
function route(a: GraphId, b: GraphId, k = 1) {
  const [ax, ay0] = POS[a];
  const [bx, by0] = POS[b];
  const ay = ay0 * k;
  const by = by0 * k;
  if (Math.abs(ay - by) < 2) return `M${ax},${ay}H${bx}`;
  if (Math.abs(ax - bx) < 2) return `M${ax},${ay}V${by}`;
  const my = (ay + by) / 2;
  const r = Math.min(9, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 4);
  const sx = Math.sign(bx - ax);
  const sy = Math.sign(by - ay);
  return [
    `M${ax},${ay}`,
    `V${my - sy * r}`,
    `Q${ax},${my} ${ax + sx * r},${my}`,
    `H${bx - sx * r}`,
    `Q${bx},${my} ${bx},${my + sy * r}`,
    `V${by}`,
  ].join("");
}

const edgeKey = (a: GraphId, b: GraphId) => (a < b ? `${a}|${b}` : `${b}|${a}`);

type EdgeState = "idle" | "used" | "call" | "human" | "failed";

interface NodeStat {
  running: number;
  ok: number;
  err: number;
  cost: number;
  calls: number;
  ms: number;
  /** Real mode: the node's newest backend run, and the newest model it recorded. */
  last?: LiveSpan;
  model?: string;
  vendor?: Vendor;
}

/** With `fill`, the graph takes its container's full height and spreads the rows over it (never tighter than the base layout). */
export function AgentGraph({ big = false, fill = false }: { big?: boolean; fill?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ k: 1, roomy: true });
  const k = fit.k;
  useEffect(() => {
    const el = box.current?.parentElement;
    if (!fill || !el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0) return;
      const nk = Math.max(1, Math.min(1.8, (h / w) * (GW / GH)));
      // large nodes need ~84 px between rows; a short column falls back to the small ones
      setFit({ k: nk, roomy: 82 * nk * (w / GW) >= 84 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const H = GH * k;
  const spans = useOps((s) => s.spans);
  const humans = useOps((s) => s.humans);
  const focusAgent = useOps((s) => s.focusAgent);
  const parties = useOps((s) => s.events.find((e) => e.id === s.focusEvent)?.parties);
  const real = useRealMode();
  const now = useNow(250);

  const { edges, answers, nodeState, others } = useMemo(() => {
    const edges = new Map<string, { a: GraphId; b: GraphId; state: EdgeState; from: GraphId }>();
    for (const [a, b] of SKELETON) edges.set(edgeKey(a, b), { a, b, state: "idle", from: a });
    const answers: { id: string; d: string; color: string }[] = [];
    const nodeState = new Map<GraphId, NodeStat>();
    // the backend names behind the generic node, for its tooltip
    const others = new Set<string>();
    const bump = (id: GraphId, k: "running" | "ok" | "err" | null, s: Span) => {
      const st: NodeStat = nodeState.get(id) ?? { running: 0, ok: 0, err: 0, cost: 0, calls: 0, ms: 0 };
      if (k) st[k]++;
      st.calls++;
      st.cost += s.costUsd ?? 0;
      st.ms += s.ms ?? 0;
      nodeState.set(id, st);
      return st;
    };
    const rank: Record<EdgeState, number> = { idle: 0, used: 1, call: 3, human: 2, failed: 4 };
    for (const s of spans) {
      const a: GraphId = s.agent;
      const b: GraphId = s.target;
      // a backend run names itself as its target: it lights its node, there is no edge to draw
      if (a !== b) {
        const key = edgeKey(a, b);
        const prev = edges.get(key);
        // a finished call keeps its line for a few seconds, then only the skeleton remains
        // (all of a focused agent's lines stay, so its reach is readable)
        const fresh = s.status === "running" || now - (s.t1 ?? s.t0) < 10_000 || s.agent === focusAgent || s.target === focusAgent;
        if (fresh || prev) {
          let state: EdgeState = fresh ? "used" : "idle";
          if (s.status === "running") state = s.kind === "human" ? "human" : "call";
          else if (s.status === "error" && now - (s.t1 ?? 0) < 6000) state = "failed";
          if (!prev || rank[state] >= rank[prev.state]) edges.set(key, { a, b, state, from: a });
        } else if (!real) continue; // a backend run still counts on its node after its line is gone
      }
      // a stalled or superseded backend run ("waiting") is neither an answer nor a failure
      const st = bump(a, s.status === "running" ? "running" : s.status === "error" ? "err" : s.status === "waiting" ? null : "ok", s);
      if (s.status === "running" && a !== b) bump(b, "running", s);
      if (s.status === "ok" && s.t1 && now - s.t1 < 900 && a !== b) answers.push({ id: s.id, d: route(a, b, k), color: EDGE.answer });
      if (isLiveSpan(s)) {
        st.last = s;
        st.model = s.model ?? st.model;
        st.vendor = vendorOf(s) ?? st.vendor;
        if (isOther(a)) others.add(backendName(s.backendAgent));
      }
    }
    for (const h of humans) {
      const id: NodeId = h.side === "a" ? "humanA" : "humanB";
      edges.set(edgeKey("host", id), { a: "host", b: id, state: "human", from: "host" });
    }
    return { edges, answers, nodeState, others: [...others] };
  }, [spans, humans, now, focusAgent, k, real]);

  const waitingHuman = new Set<NodeId>(humans.map((h) => (h.side === "a" ? "humanA" : "humanB")));
  // people come from the focused event: two deciding operators plus anyone the fix affects
  const shownParties: Party[] = parties ?? [
    { id: "humanA", role: "a", operator: "Operator A", owner: "", country: null, language: null },
    { id: "humanB", role: "b", operator: "Operator B", owner: "", country: null, language: null },
  ];
  const partyById = new Map(shownParties.map((p) => [p.id, p]));
  const showOther = nodeState.has(OTHER) || [...edges.values()].some((e) => isOther(e.a) || isOther(e.b));
  const nodes = (Object.keys(POS) as GraphId[]).filter((id) =>
    isOther(id) ? showOther : !id.startsWith("human") || partyById.has(id as HumanId),
  );

  return (
    <div ref={box} className="relative w-full select-none" style={{ aspectRatio: `${GW} / ${H}` }}>
      <svg viewBox={`0 0 ${GW} ${H}`} className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <filter id="pulse-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>
        {[...edges.values()].map(({ a, b, state, from }) => {
          const d = route(from, from === a ? b : a, k);
          const color = state === "call" ? EDGE.call : state === "human" ? EDGE.human : state === "failed" ? EDGE.failed : "#ffffff";
          const op = state === "idle" ? 0.07 : state === "used" ? 0.16 : 0.75;
          return (
            <g key={edgeKey(a, b)}>
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeOpacity={op}
                strokeWidth={state === "idle" || state === "used" ? 1 : 1.4}
                strokeDasharray={state === "human" ? "4 4" : undefined}
                className={state === "human" ? "edge-march" : undefined}
                style={{ transition: "stroke-opacity .4s, stroke .4s" }}
              />
              {state === "call" && (
                <>
                  <circle r="5" fill={color} opacity="0.5" filter="url(#pulse-glow)">
                    <animateMotion dur="1.15s" repeatCount="indefinite" path={d} />
                  </circle>
                  <circle r="2.2" fill="#fff">
                    <animateMotion dur="1.15s" repeatCount="indefinite" path={d} />
                  </circle>
                </>
              )}
            </g>
          );
        })}
        {answers.map((a) => (
          <g key={a.id}>
            <circle r="5" fill={a.color} opacity="0.55" filter="url(#pulse-glow)">
              <animateMotion dur="0.75s" fill="freeze" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={a.d} />
            </circle>
            <circle r="2.2" fill={a.color}>
              <animateMotion dur="0.75s" fill="freeze" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={a.d} />
            </circle>
          </g>
        ))}
      </svg>

      {nodes.map((id) => {
        const node = (
          <GraphNode
            key={id}
            id={id}
            big={big && (!fill || fit.roomy)}
            st={nodeState.get(id)}
            real={real}
            others={others}
            waiting={waitingHuman.has(id as NodeId)}
            dim={focusAgent !== null && id !== focusAgent}
            focused={focusAgent === id}
            party={partyById.get(id as HumanId)}
          />
        );
        // the generic node comes with its runs, so it fades in instead of popping (opacity only: a transform here
        // would become the containing block of the absolutely placed node)
        return isOther(id) ? (
          <motion.div key={id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
            {node}
          </motion.div>
        ) : (
          node
        );
      })}
    </div>
  );
}

function GraphNode({
  id,
  big,
  st,
  real,
  others,
  waiting,
  dim,
  focused,
  party,
}: {
  id: GraphId;
  party?: Party;
  big: boolean;
  st?: NodeStat;
  real: boolean;
  /** The backend names behind the generic node. */
  others: string[];
  waiting: boolean;
  dim: boolean;
  focused: boolean;
}) {
  const generic = isOther(id);
  const isAgent = id in AGENTS;
  const agentLike = isAgent || generic;
  const isHuman = id.startsWith("human");
  const size = agentLike ? (big ? 48 : 38) : isHuman ? (big ? 40 : 32) : big ? 34 : 28;
  const [x, y] = POS[id];
  // real mode: the node's newest backend run says what it is doing; a stalled one glows orange without spinning
  const last = real ? st?.last : undefined;
  const stalled = last?.output.runStatus === "running" && last.output.stalled === true;
  const running = (st?.running ?? 0) > 0 || waiting;
  const ringColor = waiting ? EDGE.human : EDGE.call;
  const glow = running ? ringColor : stalled ? EDGE.human : null;
  const failed = real ? last?.status === "error" : (st?.err ?? 0) > 0;
  const answered = real ? last?.status === "ok" : (st?.ok ?? 0) > 0 && !(st?.err ?? 0);
  const label = generic
    ? "Other"
    : isAgent
      ? AGENTS[id as AgentId].short
      : isHuman
        ? shortOperator(party?.operator ?? HUMANS[id as HumanId].name)
        : TOOLS[id as keyof typeof TOOLS].name;
  const sub =
    agentLike && real
      ? runLine(st, last, stalled)
      : isAgent
        ? MODELS[AGENTS[id as AgentId].model].label
        : isHuman && party
          ? party.role === "affected"
            ? "Affected · notice"
            : `Side ${party.role.toUpperCase()}${party.language ? ` · ${party.language}` : ""}`
          : null;
  const info = generic
    ? `Runs from agents this view does not place: ${others.join(", ")}.`
    : isAgent
      ? AGENTS[id as AgentId].role
      : isHuman
        ? party
          ? `${party.operator}. ${party.role === "affected" ? "Satellite near the new path; notified before the burn." : `Decides for side ${party.role.toUpperCase()}.`}`
          : HUMANS[id as HumanId].detail
        : TOOLS[id as keyof typeof TOOLS].detail;
  const glyph = agentLike ? (big ? 20 : 17) : big ? 15 : 13;

  return (
    <div
      className="absolute"
      style={{ left: `${(x / GW) * 100}%`, top: `${(y / GH) * 100}%`, transform: "translate(-50%, -50%)", zIndex: focused ? 3 : 2 }}
    >
      <Tooltip
        side="bottom"
        label={
          <span className="block max-w-[220px]">
            <span className="block font-medium text-fg">{generic ? "Other agents" : isAgent ? AGENTS[id as AgentId].name : label}</span>
            <span className="block text-muted">{info}</span>
            {last && (
              <span className="mono mt-1 block text-[10px] text-fg-2">
                {[last.output.stage && stageLabel(last.output.stage), stalled ? "stalled" : last.output.runStatus, st?.model]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {st && st.calls > 0 && (
              <span className="mono mt-1 block text-[10px] text-fg-2">
                {st.calls} {real ? "runs" : "steps"}
                {agentLike && ` · ${fmtUsd(real ? null : st.cost)}`}
                {st.ms > 0 && ` · ${fmtMs(st.ms / Math.max(st.ok + st.err, 1))} avg`}
              </span>
            )}
          </span>
        }
      >
        <button
          className="group relative flex flex-col items-center outline-none"
          style={{ opacity: dim ? 0.35 : 1, transition: "opacity .3s" }}
          onClick={() => {
            if (!isAgent) return;
            sfx.click();
            const s = useOps.getState();
            s.set({ focusAgent: s.focusAgent === id ? null : (id as AgentId) });
          }}
          onPointerEnter={() => sfx.hover()}
        >
          <span
            className="relative grid place-items-center transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:scale-[1.07] group-active:scale-95"
            style={{
              width: size,
              height: size,
              borderRadius: agentLike ? (big ? 14 : 12) : 9,
              background: agentLike ? "linear-gradient(180deg,#1d1f24,#141518)" : "#121316",
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,${focused ? 0.28 : 0.09}), 0 6px 16px -6px rgba(0,0,0,0.7)${glow ? `, 0 0 22px -4px ${glow}` : ""}`,
              color: isHuman ? (waiting ? EDGE.human : "var(--fg-2)") : "var(--fg-2)",
            }}
          >
            {running && <span className="node-ring" style={{ borderRadius: agentLike ? (big ? 16 : 14) : 11, ["--ring" as string]: ringColor }} />}
            {isHuman && party?.country ? (
              <PartyFace country={party.country} size={size} />
            ) : agentLike && (real || generic) ? (
              <VendorGlyph vendor={st?.vendor} size={glyph} />
            ) : (
              <NodeGlyph id={id as NodeId} size={glyph} />
            )}
            {agentLike && !running && failed && (
              <Badge color={EDGE.failed}>
                <X size={8} strokeWidth={3} />
              </Badge>
            )}
            {agentLike && !running && answered && (
              <Badge color={EDGE.answer}>
                <Check size={8} strokeWidth={3} />
              </Badge>
            )}
          </span>
          {/* labels sit on a knockout so edges passing underneath don't cut through the text */}
          <span className="mt-[3px] flex flex-col items-center rounded-[5px] bg-[#0d0e10]/85 px-1 py-[2px]">
            <span className={`whitespace-nowrap font-medium leading-none ${agentLike ? (big ? "text-[11.5px]" : "text-[10.5px]") : "text-[9.5px] text-muted"}`}>
              {label}
            </span>
            {sub && (
              <span className={`mt-[3px] whitespace-nowrap leading-none ${stalled ? "text-orange" : "text-muted"} ${big ? "text-[10px]" : "text-[9px]"}`}>
                {sub}
              </span>
            )}
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

/** Real mode, under an agent: "Stalled", the running stage, else the recorded model (or its vendor). Nothing before a run. */
function runLine(st: NodeStat | undefined, last: LiveSpan | undefined, stalled: boolean): string | null {
  if (stalled) return "Stalled";
  if (last?.status === "running" && last.output.stage) return stageLabel(last.output.stage);
  if (st?.model && MODELS[st.model]) return MODELS[st.model].label;
  return st?.vendor ? VENDOR_LABEL[st.vendor] : null;
}

/** Real mode: the mark of the provider a run recorded; a neutral one before any run or for a provider without a mark. */
function VendorGlyph({ vendor, size }: { vendor?: Vendor; size: number }) {
  if (vendor === "anthropic") return <ClaudeGlyph size={size} />;
  if (vendor === "xai") return <GrokGlyph size={size} />;
  return <Bot size={size - 2} strokeWidth={1.8} />;
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <motion.span
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 600, damping: 22 }}
      className="absolute -right-1.5 -top-1.5 grid h-[14px] w-[14px] place-items-center rounded-full text-black"
      style={{ background: color, boxShadow: `0 0 0 2px #0c0d0f, 0 0 10px ${color}` }}
    >
      {children}
    </motion.span>
  );
}

export function GraphLegend() {
  const items: [string, string, boolean?][] = [
    ["Call", EDGE.call],
    ["Answer", EDGE.answer],
    ["Needs you", EDGE.human, true],
    ["Failed", EDGE.failed],
  ];
  return (
    <div className="flex items-center justify-center gap-3 text-[10px] text-muted">
      {items.map(([l, c, dashed]) => (
        <span key={l} className="flex items-center gap-1.5">
          <svg width="14" height="4">
            <line x1="0" x2="14" y1="2" y2="2" stroke={c} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} strokeLinecap="round" />
          </svg>
          {l}
        </span>
      ))}
    </div>
  );
}

const shortOperator = (name: string) => name.replace(/\s*\(synthetic\)/i, "").replace(/^(SpaceX|Eutelsat) /, "$1 ").slice(0, 18);

/** A dispatcher shown by their country's flag, with a small person badge so it still reads as a person. */
function PartyFace({ country, size }: { country: string; size: number }) {
  return (
    <span className="relative block h-full w-full overflow-hidden" style={{ borderRadius: 9 }}>
      <span className="absolute inset-0 grid place-items-center [&>img]:!h-full [&>img]:!w-full [&>img]:!rounded-none [&>img]:!shadow-none">
        <Flag code={country} h={size} />
      </span>
      <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.18),transparent_45%,rgba(0,0,0,0.35))]" />
      <span className="absolute inset-0 rounded-[9px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]" />
      <span className="absolute bottom-[2px] right-[2px] grid h-[11px] w-[11px] place-items-center rounded-full bg-black/70 text-white">
        <User size={7} strokeWidth={2.6} />
      </span>
    </span>
  );
}
