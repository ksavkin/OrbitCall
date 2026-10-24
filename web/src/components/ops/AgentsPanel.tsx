"use client";

import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Minimize2, Workflow, X } from "lucide-react";
import { useMemo } from "react";
import { fmtUsd } from "@/lib/ops/format";
import { AGENT_ORDER, AGENTS, TOOLS } from "@/lib/ops/roster";
import { useOps, type AgentView } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentGraph, GraphLegend } from "./AgentGraph";
import { CallFeed, LogStream, TraceList } from "./AgentTrace";

const VIEWS: { id: AgentView; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "trace", label: "Trace" },
  { id: "logs", label: "Logs" },
];

function useRunStats() {
  const spans = useOps((s) => s.spans);
  const now = useNow(1000);
  return useMemo(() => {
    const running = new Set(spans.filter((s) => s.status === "running").map((s) => s.agent));
    const perMin = now ? spans.filter((s) => now - s.t0 < 60_000).length : 0;
    const cost = spans.reduce((a, s) => a + (s.costUsd ?? 0), 0);
    const unpriced = spans.some((s) => s.costUsd === null);
    return { running: running.size, perMin, cost, unpriced };
  }, [spans, now]);
}

function Header({ expanded }: { expanded: boolean }) {
  const dev = useOps((s) => s.dev);
  const focusAgent = useOps((s) => s.focusAgent);
  const st = useRunStats();
  return (
    <div className="flex items-center gap-2 px-3 pb-2 pt-3">
      <Workflow size={14} className="text-blue" />
      <span className="text-[13px] font-semibold tracking-[-0.01em]">Agents</span>
      <div className="mono ml-auto flex items-center gap-2.5 text-[10.5px] text-muted">
        <span>
          <span className="text-fg">{AGENT_ORDER.length}</span> agents
        </span>
        {!expanded ? null : (
          <span>
            <span className="text-fg">{Object.keys(TOOLS).length}</span> tools
          </span>
        )}
        <span className={st.running ? "text-blue" : ""}>
          <span className={st.running ? "text-blue" : "text-fg"}>{st.running}</span> running
        </span>
        <Tooltip label="Steps started in the last minute">
          <span>
            <span className="text-fg">{st.perMin}</span>/min
          </span>
        </Tooltip>
        <Tooltip label={st.unpriced ? "Claude at list price. Grok steps aren't priced yet." : "Claude at list price per token"}>
          <span className="text-fg">
            {fmtUsd(st.cost)}
            {st.unpriced && <span className="text-faint">*</span>}
          </span>
        </Tooltip>
      </div>
      <Tooltip label={expanded ? "Collapse" : "Expand"} hint={expanded ? "Esc" : undefined}>
        <button
          className="icon-btn -mr-1 h-6 w-6"
          disabled={!dev}
          onClick={() => {
            sfx.whoosh();
            useOps.getState().set({ agentsExpanded: !expanded });
          }}
          aria-label={expanded ? "Collapse agents" : "Expand agents"}
        >
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </Tooltip>
      {focusAgent && (
        <span className="sr-only" aria-live="polite">
          Showing {AGENTS[focusAgent].name}
        </span>
      )}
    </div>
  );
}

function FocusPill() {
  const focusAgent = useOps((s) => s.focusAgent);
  return (
    <AnimatePresence>
      {focusAgent && (
        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="flex h-[22px] items-center gap-1 rounded-full bg-white/[0.06] pl-2 pr-1 text-[10.5px] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-white/[0.1]"
          onClick={() => useOps.getState().set({ focusAgent: null, focusSpan: null })}
        >
          {AGENTS[focusAgent].short}
          <X size={11} className="text-muted" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function ViewTabs() {
  const view = useOps((s) => s.agentView);
  return (
    <div className="flex items-center gap-0.5 px-2 pb-2">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className="btn relative h-6 px-2.5 text-[11px]"
          data-active={view === v.id}
          onClick={() => {
            if (view === v.id) return;
            sfx.click();
            useOps.getState().set({ agentView: v.id });
          }}
        >
          {view === v.id && <motion.span layoutId="agents-view" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          <span className="relative">{v.label}</span>
        </button>
      ))}
      <span className="ml-auto">
        <FocusPill />
      </span>
    </div>
  );
}

function NoBackend() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <Workflow size={18} className="text-faint" />
      <div className="mt-2 text-[12px] font-medium">No agent runs</div>
      <p className="mt-1 max-w-[240px] text-[11px] leading-[1.5] text-muted">
        Runs stream here from the backend: every model call, tool call and handoff, with tokens, latency and cost.
      </p>
    </div>
  );
}

/** Right-hand agents window on the Conjunctions screen. */
export function AgentsPanel() {
  const dev = useOps((s) => s.dev);
  const view = useOps((s) => s.agentView);
  return (
    <motion.aside
      initial={{ opacity: 0, x: 16, filter: "blur(8px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: 16, filter: "blur(8px)" }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="glass pointer-events-auto absolute bottom-[42px] right-2.5 top-[58px] z-20 flex w-[372px] flex-col overflow-hidden rounded-[14px]"
    >
      <Header expanded={false} />
      {!dev ? (
        <NoBackend />
      ) : (
        <>
          <ViewTabs />
          <div className="mx-3 h-px bg-white/[0.06]" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              {view === "graph" && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="shrink-0 px-4 pt-2">
                    <AgentGraph />
                    <div className="py-2">
                      <GraphLegend />
                    </div>
                  </div>
                  <div className="mx-3 mb-1.5 flex items-center gap-2">
                    <span className="eyebrow">Calls</span>
                    <span className="h-px flex-1 bg-white/[0.05]" />
                    <span className="text-[9.5px] text-faint">newest first</span>
                  </div>
                  <CallFeed className="flex-1" />
                </div>
              )}
              {view === "trace" && (
                <div className="min-h-0 flex-1 pt-1">
                  <TraceList />
                </div>
              )}
              {view === "logs" && (
                <div className="min-h-0 flex-1 pt-1.5">
                  <LogStream />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </motion.aside>
  );
}

/** Full-screen agent operations view: big graph, live step, trace and log side by side. */
export function AgentsExpanded() {
  const open = useOps((s) => s.agentsExpanded && s.dev && s.tab === "conjunctions");
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="agents-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-auto absolute inset-x-0 bottom-0 top-[52px] z-40 bg-black/45 backdrop-blur-[6px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) useOps.getState().set({ agentsExpanded: false });
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="glass glass-strong absolute inset-x-2.5 bottom-[42px] top-[6px] flex flex-col overflow-hidden rounded-[16px]"
          >
            <Header expanded />
            <div className="mx-3 h-px bg-white/[0.06]" />
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
              <div className="flex min-h-0 flex-col overflow-hidden border-r border-white/[0.06] px-6 pb-4 pt-3">
                <div className="mx-auto w-full max-w-[520px]">
                  <AgentGraph big />
                  <div className="py-3">
                    <GraphLegend />
                  </div>
                </div>
                <div className="mx-auto mb-1.5 flex w-full max-w-[520px] items-center gap-2">
                  <span className="eyebrow">Calls</span>
                  <span className="h-px flex-1 bg-white/[0.05]" />
                </div>
                <CallFeed className="mx-auto min-h-[240px] w-full max-w-[540px] flex-1" />
              </div>
              <div className="flex min-h-0 flex-col">
                <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                  <span className="eyebrow">Trace</span>
                  <span className="ml-auto">
                    <FocusPill />
                  </span>
                </div>
                <div className="min-h-0 flex-[1.4]">
                  <TraceList big />
                </div>
                <div className="mx-3 h-px bg-white/[0.06]" />
                <div className="px-3 pb-1 pt-2.5">
                  <span className="eyebrow">Log</span>
                </div>
                <div className="min-h-0 flex-1">
                  <LogStream />
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
