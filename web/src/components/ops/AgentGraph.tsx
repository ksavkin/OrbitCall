"use client";

import { motion } from "motion/react";
import { Check, X } from "lucide-react";
import { useMemo } from "react";
import { fmtMs, fmtUsd } from "@/lib/ops/format";
import { AGENTS, HUMANS, MODELS, TOOLS } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import type { AgentId, HumanId, NodeId, Span } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Tooltip } from "@/components/ui/Tooltip";
import { NodeGlyph } from "./Glyphs";
import { EDGE } from "./meta";

// Agent graph: the pipeline from docs/plan-v1.md §5 laid out top to bottom, data
// sources on top, tools at the sides. Edges light up from live spans: a blue pulse
// travels out while a call runs, a green one comes back with the answer.

export const GW = 400;
export const GH = 500;

const POS: Record<NodeId, [number, number]> = {
  celestrak: [110, 34],
  socrates: [200, 34],
  spacetrack: [290, 34],
  monitor: [200, 108],
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
  schedule: [52, 440],
  scheduler: [140, 440],
  verifier: [260, 440],
  room: [348, 440],
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
function route(a: NodeId, b: NodeId) {
  const [ax, ay] = POS[a];
  const [bx, by] = POS[b];
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

const edgeKey = (a: NodeId, b: NodeId) => (a < b ? `${a}|${b}` : `${b}|${a}`);

type EdgeState = "idle" | "used" | "call" | "human" | "failed";

export function AgentGraph({ big = false }: { big?: boolean }) {
  const spans = useOps((s) => s.spans);
  const humans = useOps((s) => s.humans);
  const focusAgent = useOps((s) => s.focusAgent);
  const now = useNow(250);

  const { edges, answers, nodeState } = useMemo(() => {
    const edges = new Map<string, { a: NodeId; b: NodeId; state: EdgeState; from: NodeId }>();
    for (const [a, b] of SKELETON) edges.set(edgeKey(a, b), { a, b, state: "idle", from: a });
    const answers: { id: string; d: string; color: string }[] = [];
    const nodeState = new Map<NodeId, { running: number; ok: number; err: number; cost: number; calls: number; ms: number }>();
    const bump = (id: NodeId, k: "running" | "ok" | "err", s: Span) => {
      const st = nodeState.get(id) ?? { running: 0, ok: 0, err: 0, cost: 0, calls: 0, ms: 0 };
      st[k]++;
      st.calls++;
      st.cost += s.costUsd ?? 0;
      st.ms += s.ms ?? 0;
      nodeState.set(id, st);
    };
    const rank: Record<EdgeState, number> = { idle: 0, used: 1, call: 3, human: 2, failed: 4 };
    for (const s of spans) {
      const key = edgeKey(s.agent, s.target);
      const prev = edges.get(key);
      // a finished call keeps its line for a few seconds, then only the skeleton remains
      // (all of a focused agent's lines stay, so its reach is readable)
      const fresh = s.status === "running" || now - (s.t1 ?? s.t0) < 10_000 || s.agent === focusAgent || s.target === focusAgent;
      let state: EdgeState = fresh ? "used" : "idle";
      if (!fresh && !prev) continue;
      if (s.status === "running") state = s.kind === "human" ? "human" : "call";
      else if (s.status === "error" && now - (s.t1 ?? 0) < 6000) state = "failed";
      if (!prev || rank[state] >= rank[prev.state]) edges.set(key, { a: s.agent, b: s.target, state, from: s.agent });
      bump(s.agent, s.status === "running" ? "running" : s.status === "error" ? "err" : "ok", s);
      if (s.status === "running") bump(s.target, "running", s);
      if (s.status === "ok" && s.t1 && now - s.t1 < 900) answers.push({ id: s.id, d: route(s.agent, s.target), color: EDGE.answer });
    }
    for (const h of humans) {
      const id: NodeId = h.side === "a" ? "humanA" : "humanB";
      edges.set(edgeKey("host", id), { a: "host", b: id, state: "human", from: "host" });
    }
    return { edges, answers, nodeState };
  }, [spans, humans, now, focusAgent]);

  const waitingHuman = new Set<NodeId>(humans.map((h) => (h.side === "a" ? "humanA" : "humanB")));
  const nodes = Object.keys(POS) as NodeId[];

  return (
    <div className="relative w-full select-none" style={{ aspectRatio: `${GW} / ${GH}` }}>
      <svg viewBox={`0 0 ${GW} ${GH}`} className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <filter id="pulse-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>
        {[...edges.values()].map(({ a, b, state, from }) => {
          const d = route(from, from === a ? b : a);
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

      {nodes.map((id) => (
        <GraphNode
          key={id}
          id={id}
          big={big}
          st={nodeState.get(id)}
          waiting={waitingHuman.has(id)}
          dim={focusAgent !== null && id !== focusAgent}
          focused={focusAgent === id}
        />
      ))}
    </div>
  );
}

function GraphNode({
  id,
  big,
  st,
  waiting,
  dim,
  focused,
}: {
  id: NodeId;
  big: boolean;
  st?: { running: number; ok: number; err: number; cost: number; calls: number; ms: number };
  waiting: boolean;
  dim: boolean;
  focused: boolean;
}) {
  const isAgent = id in AGENTS;
  const isHuman = id === "humanA" || id === "humanB";
  const size = isAgent ? (big ? 48 : 38) : big ? 34 : 28;
  const [x, y] = POS[id];
  const running = (st?.running ?? 0) > 0 || waiting;
  const ringColor = waiting ? EDGE.human : EDGE.call;
  const label = isAgent ? AGENTS[id as AgentId].short : isHuman ? HUMANS[id as HumanId].name : TOOLS[id as keyof typeof TOOLS].name;
  const sub = isAgent ? MODELS[AGENTS[id as AgentId].model].label : null;
  const info = isAgent ? AGENTS[id as AgentId].role : isHuman ? HUMANS[id as HumanId].detail : TOOLS[id as keyof typeof TOOLS].detail;

  return (
    <div
      className="absolute"
      style={{ left: `${(x / GW) * 100}%`, top: `${(y / GH) * 100}%`, transform: "translate(-50%, -50%)", zIndex: focused ? 3 : 2 }}
    >
      <Tooltip
        side="bottom"
        label={
          <span className="block max-w-[220px]">
            <span className="block font-medium text-fg">{isAgent ? AGENTS[id as AgentId].name : label}</span>
            <span className="block text-muted">{info}</span>
            {st && st.calls > 0 && (
              <span className="mono mt-1 block text-[10px] text-fg-2">
                {st.calls} steps{isAgent && ` · ${fmtUsd(st.cost)}`}
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
              borderRadius: isAgent ? (big ? 14 : 12) : 9,
              background: isAgent ? "linear-gradient(180deg,#1d1f24,#141518)" : "#121316",
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,${focused ? 0.28 : 0.09}), 0 6px 16px -6px rgba(0,0,0,0.7)${running ? `, 0 0 22px -4px ${ringColor}` : ""}`,
              color: isHuman ? (waiting ? EDGE.human : "var(--fg-2)") : "var(--fg-2)",
            }}
          >
            {running && <span className="node-ring" style={{ borderRadius: isAgent ? (big ? 16 : 14) : 11, ["--ring" as string]: ringColor }} />}
            <NodeGlyph id={id} size={isAgent ? (big ? 20 : 17) : big ? 15 : 13} />
            {isAgent && !running && (st?.err ?? 0) > 0 && (
              <Badge color={EDGE.failed}>
                <X size={8} strokeWidth={3} />
              </Badge>
            )}
            {isAgent && !running && (st?.ok ?? 0) > 0 && !(st?.err ?? 0) && (
              <Badge color={EDGE.answer}>
                <Check size={8} strokeWidth={3} />
              </Badge>
            )}
          </span>
          {/* labels sit on a knockout so edges passing underneath don't cut through the text */}
          <span className="mt-[3px] flex flex-col items-center rounded-[5px] bg-[#0d0e10]/85 px-1 py-[2px]">
            <span className={`whitespace-nowrap font-medium leading-none ${isAgent ? (big ? "text-[11.5px]" : "text-[10.5px]") : "text-[9.5px] text-muted"}`}>
              {label}
            </span>
            {sub && <span className={`mt-[3px] whitespace-nowrap leading-none text-muted ${big ? "text-[10px]" : "text-[9px]"}`}>{sub}</span>}
          </span>
        </button>
      </Tooltip>
    </div>
  );
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
