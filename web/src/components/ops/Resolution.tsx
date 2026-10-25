"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, CheckCheck, Radar, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { fmtMiss, fmtMs, fmtOdds, fmtUsd, fmtWhen } from "@/lib/ops/format";
import { runScan } from "@/lib/ops/scenarios";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Proposal, Reply } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { ObjectChip } from "./Entity";

// The end of the loop: green edge glow and one card that says who decided what, what was
// done, what was checked, and what happens next. Everything comes from the run itself.

const ANSWER = {
  approved: { label: "approved", color: "var(--green)" },
  vetoed: { label: "rejected", color: "var(--red)" },
  countered: { label: "countered", color: "var(--orange)" },
} as const;

export function ResolutionOverlay() {
  const resolved = useOps((s) => s.resolved);
  const tab = useOps((s) => s.tab);
  const ev = useOps((s) => (s.resolved ? s.events.find((e) => e.id === s.resolved!.eventId) : undefined));
  const replies = useOps((s) => s.replies);
  const spans = useOps((s) => s.spans);
  const played = useRef<string | null>(null);
  const open = !!resolved && !!ev && tab === "conjunctions";

  useEffect(() => {
    if (!resolved || played.current === `${resolved.eventId}:${resolved.at}`) return;
    played.current = `${resolved.eventId}:${resolved.at}`;
    sfx.resolved();
  }, [resolved]);

  const stats = useMemo(() => {
    if (!ev) return null;
    const mine = spans.filter((s) => s.eventId === ev.id);
    return {
      steps: mine.length,
      cost: mine.reduce((a, s) => a + (s.costUsd ?? 0), 0),
      unpriced: mine.some((s) => s.costUsd === null),
      revisions: Math.max((ev.proposal?.version ?? 1) - 1, 0),
    };
  }, [ev, spans]);

  const close = () => {
    sfx.close();
    // the case is closed: free the board for the next scan
    useOps.setState({ resolved: null, incident: null, incidentView: "expanded" });
  };

  return (
    <AnimatePresence>
      {open && ev && stats && (
        <motion.div key="resolved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }} className="absolute inset-0 z-[46]">
          {/* green edge: bright on arrival, then settles */}
          <motion.div
            className="urgency-edge resolve-edge pointer-events-none absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0.55, 0.85, 0.45] }}
            transition={{ duration: 2.4, times: [0, 0.15, 0.45, 0.65, 1] }}
          />
          <motion.div
            className="pointer-events-none absolute inset-0"
            initial={{ background: "rgba(61,220,151,0.16)" }}
            animate={{ background: "rgba(0,0,0,0.32)" }}
            transition={{ duration: 1.2 }}
          />
          <div
            className="absolute inset-0 grid place-items-center overflow-y-auto py-16"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 18, filter: "blur(8px)" }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.97, y: 10 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="relative w-[780px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] bg-[rgba(4,4,5,0.95)] text-neutral-200 backdrop-blur-2xl"
              style={{ boxShadow: "0 0 0 1px rgba(61,220,151,0.4), 0 30px 80px -20px rgba(0,0,0,0.9), 0 0 60px -14px rgba(61,220,151,0.5)" }}
            >
              <Header ev={ev} onClose={close} />
              <div className="thin-scroll max-h-[min(72vh,720px)] space-y-6 overflow-y-auto px-6 pb-5">
                <Problem ev={ev} />
                <Story ev={ev} replies={replies.filter((r) => r.eventId === ev.id)} />
                <Verdict ev={ev} revisions={stats.revisions} />
                <Checks ev={ev} />
                <Next ev={ev} />
              </div>
              <div className="flex items-center gap-3 border-t border-white/[0.07] px-5 py-3 text-[10.5px] text-muted">
                <span className="mono">
                  {stats.steps} agent steps · {fmtUsd(stats.cost)}
                  {stats.unpriced && <span className="text-faint">*</span>}
                </span>
                <button
                  className="btn btn-ghost-line ml-auto h-8 px-3 text-[11.5px]"
                  onClick={() => {
                    close();
                    runScan();
                  }}
                >
                  <Radar size={12} /> Run another scan
                </button>
                <button className="btn btn-primary h-8 px-3.5 text-[12px]" onClick={close}>
                  <Check size={12} /> Done
                </button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({ ev, onClose }: { ev: ConjunctionEvent; onClose: () => void }) {
  const took = ev.outcome?.resolvedAt ? ev.outcome.resolvedAt - ev.createdAt : null;
  return (
    <div className="flex items-start gap-3.5 px-5 pb-3 pt-5">
      <span className="relative grid h-12 w-12 shrink-0 place-items-center">
        <motion.span
          className="absolute inset-0 rounded-full border-2 border-green"
          initial={{ scale: 0.6, opacity: 0.9 }}
          animate={{ scale: 1.6, opacity: 0 }}
          transition={{ duration: 1.2, repeat: 2, ease: "easeOut" }}
        />
        <motion.span
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 16, delay: 0.15 }}
          className="grid h-12 w-12 place-items-center rounded-full bg-[rgba(61,220,151,0.16)] text-green shadow-[0_0_30px_-4px_rgba(61,220,151,0.7)]"
        >
          <CheckCheck size={22} />
        </motion.span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-green">Incident resolved</div>
        <div className="mt-0.5 truncate text-[17px] font-semibold tracking-[-0.015em]">
          {ev.a.name} <span className="text-faint">×</span> {ev.b.name}
        </div>
        <div className="mono mt-0.5 text-[10.5px] text-muted">
          {ev.id} · TCA {fmtWhen(ev.tca)}
          {took !== null && ` · detected to resolved in ${fmtMs(took)}`}
        </div>
      </div>
      <button className="icon-btn -mr-1 -mt-1 h-7 w-7" onClick={onClose} aria-label="Close">
        <X size={14} />
      </button>
    </div>
  );
}

function Section({ title, children, delay }: { title: string; children: React.ReactNode; delay: number }) {
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.3 }}>
      <div className="mb-2.5 border-b border-white/[0.06] pb-2 text-[12.5px] font-semibold text-neutral-200">{title}</div>
      {children}
    </motion.section>
  );
}

const nameOf = (ev: ConjunctionEvent, side: "a" | "b") =>
  (ev.parties?.find((p) => p.role === side)?.operator ?? (side === "a" ? ev.a.operator : ev.b.operator)).replace(/\s*\(synthetic\)/i, "");

const planText = (ev: ConjunctionEvent, p: Proposal) =>
  p.action === "wait" ? "Both wait for the next conjunction message" : `${p.mover === "a" ? ev.a.name : ev.b.name} ${p.action === "raise" ? "raises" : "lowers"} its orbit by ${p.dvMs} m/s`;

/** What was wrong, in one paragraph a dispatcher can repeat. */
function Problem({ ev }: { ev: ConjunctionEvent }) {
  const debris = ev.b.kind === "debris";
  return (
    <Section title="The problem" delay={0.1}>
      <p className="text-[14px] leading-[1.7] text-neutral-300">
        <ObjectChip e={ev} side="a" /> ({nameOf(ev, "a")}) and <ObjectChip e={ev} side="b" /> ({debris ? "debris, no operator" : nameOf(ev, "b")}) were predicted to pass{" "}
        <span className="tnum font-semibold text-white">{fmtMiss(ev.missM)}</span> apart on <span className="tnum font-semibold text-white">{fmtWhen(ev.tca)}</span>, crossing at{" "}
        <span className="tnum font-semibold text-white">{ev.relVelKms.toFixed(1)} km/s</span>. The chance of collision was{" "}
        <span className="tnum font-semibold text-red">{fmtOdds(ev.pc)}</span> ({ev.pcSource}), above the 1 in 10,000 line where operators act, and the two orbit sources disagreed by{" "}
        <span className="tnum font-semibold text-white">{fmtMiss(ev.uncertaintyM)}</span>.
      </p>
    </Section>
  );
}

/** How the decision was reached: every plan version, who answered what, and why it changed. */
function Story({ ev, replies }: { ev: ConjunctionEvent; replies: Reply[] }) {
  const versions = ev.proposals?.length ? ev.proposals : ev.proposal ? [ev.proposal] : [];
  const final = ev.proposal?.version;
  return (
    <Section title="How it was resolved" delay={0.2}>
      <ol className="relative space-y-4 pl-6">
        <span className="absolute bottom-2 left-[7px] top-2 w-px bg-white/[0.08]" />
        {versions.map((p, i) => {
          const answers = replies.filter((r) => r.version === p.version);
          const agreed = p.version === final;
          return (
            <motion.li key={p.version} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.08 }} className="relative">
              <span
                className="absolute -left-6 top-[3px] grid h-[15px] w-[15px] place-items-center rounded-full text-[8px] font-bold"
                style={{ background: agreed ? "var(--green)" : "#262626", color: agreed ? "#000" : "#a3a3a3", boxShadow: "0 0 0 3px rgba(4,4,5,1)" }}
              >
                {agreed ? <Check size={9} strokeWidth={3.5} /> : p.version}
              </span>
              <div className="text-[11.5px] font-medium text-neutral-500">
                Plan v{p.version} · {i === 0 ? "proposed by the agents" : p.reason ?? "revised by the agents"}
              </div>
              <div className="mt-0.5 text-[14px] font-semibold text-white">
                {planText(ev, p)}
                {p.burnAt && <span className="tnum font-normal text-neutral-400"> · burn {fmtWhen(p.burnAt)}</span>}
                <span className="tnum font-normal text-neutral-400"> · miss {fmtMiss(p.missBeforeM)} → </span>
                <span className="tnum text-white">{fmtMiss(p.missAfterM)}</span>
              </div>
              <p className="mt-1 text-[13px] leading-[1.6] text-neutral-400">{p.rationale}</p>
              {answers.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {answers.map((r, k) => (
                    <li key={k} className="text-[13px] leading-[1.55]">
                      <span className="font-medium text-neutral-200">{nameOf(ev, r.side)}</span>{" "}
                      <span style={{ color: ANSWER[r.decision].color }}>{ANSWER[r.decision].label}</span>
                      {r.note && <span className="text-neutral-300">: “{r.note}”</span>}
                      {r.original && <span className="block text-[12px] text-neutral-500">Said in {r.lang}: “{r.original}”</span>}
                    </li>
                  ))}
                </ul>
              )}
              {agreed && (
                <div className="mt-1.5 text-[12.5px] font-medium text-green">
                  {ev.b.kind === "debris" ? "Approved by the only operator: debris has no operator." : "Both sides approved this version."}
                </div>
              )}
            </motion.li>
          );
        })}
      </ol>
      {(ev.parties ?? []).some((p) => p.role === "affected") && (
        <p className="mt-3 text-[13px] text-neutral-400">
          {(ev.parties ?? [])
            .filter((p) => p.role === "affected")
            .map((p) => p.operator.replace(/\s*\(synthetic\)/i, ""))
            .join(", ")}{" "}
          operates a satellite near the new path and was notified before the burn.
        </p>
      )}
    </Section>
  );
}

function Verdict({ ev, revisions }: { ev: ConjunctionEvent; revisions: number }) {
  const p = ev.proposal;
  if (!p) return null;
  const who = p.mover === "a" ? ev.a.name : p.mover === "b" ? ev.b.name : "Nobody";
  const verb = p.action === "raise" ? "raised" : p.action === "lower" ? "lowered" : "waited";
  return (
    <Section title="Final plan" delay={0.35}>
      <div className="rounded-[12px] bg-[rgba(61,220,151,0.06)] p-3 shadow-[inset_0_0_0_1px_rgba(61,220,151,0.22)]">
        <div className="text-[14px] font-semibold tracking-[-0.01em]">
          {who} {verb}
          {p.action !== "wait" && <span className="mono"> {p.dvMs} m/s</span>}
          {p.burnAt && <span className="text-fg-2"> at {fmtWhen(p.burnAt)}</span>}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[12px]">
          <span className="text-muted">Miss at TCA</span>
          <span className="mono tnum text-red">{fmtMiss(p.missBeforeM)}</span>
          <ArrowRight size={12} className="text-muted" />
          <span className="mono tnum font-semibold text-green">{fmtMiss(p.missAfterM)}</span>
          {p.fuelKg > 0 && <span className="ml-auto mono text-[11px] text-muted">{(p.fuelKg * 1000).toFixed(1)} g fuel</span>}
        </div>
        <div className="mt-1.5 text-[11px] leading-[1.5] text-fg-2">{p.rationale}</div>
        <div className="mt-1.5 text-[10.5px] text-muted">
          Agreed on v{p.version}
          {revisions > 0 ? ` after ${revisions} revision${revisions === 1 ? "" : "s"}` : " on the first proposal"}. Both sides approved the same version.
        </div>
      </div>
    </Section>
  );
}

function Checks({ ev }: { ev: ConjunctionEvent }) {
  const checks = ev.outcome?.checks ?? [];
  if (!checks.length) return null;
  return (
    <Section title="Done and verified" delay={0.45}>
      <ul className="space-y-1.5">
        {checks.map((c, i) => (
          <motion.li
            key={c.label}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + i * 0.12 }}
            className="flex items-start gap-2"
          >
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.55 + i * 0.12, type: "spring", stiffness: 600, damping: 20 }}
              className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-full text-black"
              style={{ background: c.ok ? "var(--green)" : "var(--red)" }}
            >
              {c.ok ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
            </motion.span>
            <span className="text-[11.5px] leading-[1.45]">
              <span className="font-medium text-fg">{c.label}</span> <span className="text-muted">· {c.detail}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </Section>
  );
}

function Next({ ev }: { ev: ConjunctionEvent }) {
  const next = ev.outcome?.next ?? [];
  if (!next.length) return null;
  return (
    <Section title="Next" delay={0.6}>
      <ul className="space-y-1">
        {next.map((n) => (
          <li key={n} className="flex items-start gap-2 text-[11.5px] leading-[1.45] text-fg-2">
            <ArrowRight size={11} className="mt-[3px] shrink-0 text-muted" />
            {n}
          </li>
        ))}
      </ul>
    </Section>
  );
}
