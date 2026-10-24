"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, CheckCheck, CircleDot, Radar, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { fmtMiss, fmtMs, fmtUsd, fmtWhen } from "@/lib/ops/format";
import { runScan } from "@/lib/ops/scenarios";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party, Reply } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";

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
    useOps.setState({ resolved: null });
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
              className="glass glass-strong relative w-[620px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px]"
              style={{ boxShadow: "0 0 0 1px rgba(61,220,151,0.4), 0 30px 80px -20px rgba(0,0,0,0.9), 0 0 60px -14px rgba(61,220,151,0.5)" }}
            >
              <Header ev={ev} onClose={close} />
              <div className="thin-scroll max-h-[min(62vh,560px)] space-y-3 overflow-y-auto px-5 pb-4">
                <Verdict ev={ev} revisions={stats.revisions} />
                <Parties ev={ev} replies={replies.filter((r) => r.eventId === ev.id)} />
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
      <div className="eyebrow mb-1.5">{title}</div>
      {children}
    </motion.section>
  );
}

function Verdict({ ev, revisions }: { ev: ConjunctionEvent; revisions: number }) {
  const p = ev.proposal;
  if (!p) return null;
  const who = p.mover === "a" ? ev.a.name : p.mover === "b" ? ev.b.name : "Nobody";
  const verb = p.action === "raise" ? "raised" : p.action === "lower" ? "lowered" : "waited";
  return (
    <Section title="Verdict" delay={0.15}>
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

function Parties({ ev, replies }: { ev: ConjunctionEvent; replies: Reply[] }) {
  const parties: Party[] = ev.parties ?? [];
  return (
    <Section title="Parties" delay={0.25}>
      <div className="divide-y divide-white/[0.05] overflow-hidden rounded-[12px] bg-white/[0.03] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        {parties.map((p, i) => {
          const answers = p.role === "affected" ? [] : replies.filter((r) => r.side === p.role);
          return (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 + i * 0.08 }}
              className="flex items-start gap-2.5 px-3 py-2.5"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
                {p.country ? <Flag code={p.country} h={28} /> : <CircleDot size={13} className="text-muted" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium">{p.operator.replace(/\s*\(synthetic\)/i, "")}</span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {p.role === "affected" ? "Affected operator" : `Side ${p.role.toUpperCase()}`}
                    {p.language ? ` · ${p.language}` : ""}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.role === "affected" ? (
                    <Pill color="var(--green)">Notified before the burn · acknowledged</Pill>
                  ) : answers.length ? (
                    answers.map((r, k) => (
                      <Pill key={k} color={ANSWER[r.decision].color}>
                        {r.version ? `v${r.version} ` : ""}
                        {ANSWER[r.decision].label}
                        {r.note ? ` · “${r.note}”` : ""}
                      </Pill>
                    ))
                  ) : (
                    <Pill color="var(--muted)">No answer recorded</Pill>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </Section>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="max-w-full truncate rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 11%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 22%, transparent)` }}
    >
      {children}
    </span>
  );
}

function Checks({ ev }: { ev: ConjunctionEvent }) {
  const checks = ev.outcome?.checks ?? [];
  if (!checks.length) return null;
  return (
    <Section title="Done and verified" delay={0.4}>
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
