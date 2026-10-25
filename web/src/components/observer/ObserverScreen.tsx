"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Eye, MonitorUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fmtCountdown, fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Reply } from "@/lib/ops/types";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { PcChart } from "@/components/ops/PcChart";
import { STEPS, stepOf } from "@/components/ops/IncidentView";
import { ProposalPanel } from "@/components/proposals/ProposalPanel";
import { RoomTimeline } from "@/components/roomChat/RoomTimeline";
import { roomCards } from "@/components/roomChat/model";
import { CHANNEL, type PublicView } from "./feed";

// The large display (spec §3.1 `demo.publicView`, role demo_observer): the case, the plans, who approved what
// and the result, for people watching the demo. Read only by construction: no approval, selection, policy,
// agent trace or private message reaches this screen, and nothing on it has a control that acts.

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");

export function ObserverScreen() {
  const [view, setView] = useState<PublicView | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (m) => {
      if (!m.data || m.data === "hello") return;
      const v = m.data as PublicView;
      setView(v);
      // the shared components read events from the store; this tab's store only ever holds the public copy
      useOps.setState({ events: v.event ? [v.event] : [], replies: v.answers as Reply[], dev: true, autopilot: false });
    };
    ch.postMessage("hello");
    return () => ch.close();
  }, []);

  const fresh = view && now - view.at < 15_000;
  const e = fresh ? view.event : null;

  return (
    <div className="flex h-full flex-col bg-black text-neutral-200">
      <TopBar e={e} now={now} connected={!!fresh} />
      <AnimatePresence mode="wait">
        {e ? (
          <motion.div key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
            <Stepper e={e} />
            {view?.resolvedAt && <Resolved e={e} />}
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)]">
              <CaseColumn e={e} />
              <div className="thin-scroll min-h-0 overflow-y-auto border-x border-white/[0.06] px-6 py-5">
                {e.options?.length ? (
                  <div className="overflow-hidden rounded-[16px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
                    <ProposalPanel e={e} viewer="a" now={now} embedded readOnly />
                  </div>
                ) : (
                  <Note title={e.agentsWorking ? "The agents are working on plans" : "No plans yet"} body="Plans appear here as soon as both sides can review them." />
                )}
              </div>
              <RecordColumn e={e} answers={view?.answers ?? []} />
            </div>
          </motion.div>
        ) : (
          <motion.div key="wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid flex-1 place-items-center">
            <Note
              icon={<MonitorUp size={18} />}
              title="Waiting for a case"
              body="Open OrbitCall in another tab of this browser, turn on Dev and run a case. This screen follows it, read only. With the backend, the same screen reads the demo run's public view."
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TopBar({ e, now, connected }: { e: ConjunctionEvent | null; now: number; connected: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-white/[0.06] px-6 py-4">
      <div className="text-[17px] font-semibold tracking-[-0.01em] text-white">OrbitCall</div>
      <span className="flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[12px] text-neutral-400">
        <Eye size={12} /> Public view · read only
      </span>
      {e && (
        <span className="flex items-center gap-2 text-[14px] text-neutral-300">
          <span className="mono text-neutral-500">{e.id}</span>
          <SideFlag e={e} side="a" /> {e.a.name}
          <span className="text-neutral-600">×</span>
          <SideFlag e={e} side="b" /> {e.b.name}
          {(e.a.synthetic || e.b.synthetic) && <span className="rounded-full bg-[rgba(255,159,64,0.12)] px-2 py-[1px] text-[11px] font-medium text-orange">Simulated</span>}
        </span>
      )}
      <div className="ml-auto flex items-center gap-5">
        {e && now > 0 && (
          <div className="text-right">
            <div className="tnum text-[26px] font-semibold leading-none tracking-[-0.02em] text-white">{fmtCountdown(e.tca - now).replace("T−", "")}</div>
            <div className="mt-1 text-[11.5px] text-neutral-500">until closest approach · {fmtWhen(e.tca)}</div>
          </div>
        )}
        <span className={`flex items-center gap-1.5 text-[12px] ${connected ? "text-green" : "text-neutral-500"}`}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: connected ? "var(--green)" : "#525252" }} />
          {connected ? "Following the operator screen" : "Not connected"}
        </span>
      </div>
    </div>
  );
}

/** The dispatcher's country for a side; nothing when the side has no operator (debris). */
function SideFlag({ e, side }: { e: ConjunctionEvent; side: "a" | "b" }) {
  const c = e.parties?.find((p) => p.role === side)?.country;
  return c ? <Flag code={c} h={13} /> : null;
}

function Stepper({ e }: { e: ConjunctionEvent }) {
  const at = stepOf(e);
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 py-3">
      {STEPS.map((s, i) => {
        const done = i < at;
        const cur = i === at;
        return (
          <div key={s} className="flex flex-1 items-center gap-2.5">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
              style={{ background: done ? "var(--green)" : cur ? "#fff" : "rgba(255,255,255,0.06)", color: done || cur ? "#000" : "#737373" }}
            >
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span className={`text-[14px] ${cur ? "font-semibold text-white" : done ? "text-neutral-300" : "text-neutral-600"}`}>{s}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1" style={{ background: done ? "var(--green)" : "rgba(255,255,255,0.08)" }} />}
          </div>
        );
      })}
    </div>
  );
}

function CaseColumn({ e }: { e: ConjunctionEvent }) {
  const red = e.risk === "red";
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto px-6 py-5">
      <div className="text-[22px] font-semibold leading-snug tracking-[-0.02em] text-white">
        {e.a.name} passes {fmtMiss(e.missM)} from {e.b.name}
      </div>
      <div className="mt-1 text-[13.5px] text-neutral-500">
        {fmtWhen(e.tca)} · {Math.abs(e.where.lat).toFixed(0)}°{e.where.lat >= 0 ? "N" : "S"} {Math.abs(e.where.lon).toFixed(0)}°{e.where.lon >= 0 ? "E" : "W"} at {e.where.altKm.toFixed(0)} km
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
        <Big label="Chance of collision" value={fmtOdds(e.pc)} tone={red ? "#ff8a80" : undefined} />
        <Big label="Miss distance" value={fmtMiss(e.missM)} />
        <Big label="Relative speed" value={`${e.relVelKms.toFixed(1)} km/s`} />
        <Big label="Plan on the table" value={e.proposal ? (e.proposal.action === "wait" ? "Wait" : `${e.proposal.dvMs} m/s`) : "—"} />
      </div>
      <div className="mt-6">
        <PcChart e={e} />
      </div>
      <div className="mt-6 space-y-3 border-t border-white/[0.06] pt-5">
        <div className="text-[12px] font-semibold text-neutral-500">Who decides</div>
        {(e.parties ?? []).map((p) => (
          <div key={p.id} className="flex items-center gap-3">
            <span className="h-6 w-6 shrink-0 overflow-hidden rounded-[5px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">{p.country && <Flag code={p.country} h={24} square />}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] text-white">{clean(p.operator)}</div>
              <div className="text-[12px] text-neutral-500">
                {p.role === "affected" ? "Affected operator" : `Side ${p.role.toUpperCase()}`}
                {p.language ? ` · ${p.language}` : ""}
              </div>
            </div>
            {p.role !== "affected" && <ApprovalWord state={e.approvals[p.role]} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApprovalWord({ state }: { state: ConjunctionEvent["approvals"]["a"] }) {
  const map = { approved: ["Approved", "var(--green)"], vetoed: ["Vetoed", "#ff8a80"], countered: ["Asked for changes", "var(--orange)"], pending: ["Not yet", "#737373"] } as const;
  const [w, c] = map[state];
  return (
    <span className="text-[13px] font-medium" style={{ color: c }}>
      {w}
    </span>
  );
}

function RecordColumn({ e, answers }: { e: ConjunctionEvent; answers: PublicView["answers"] }) {
  const cards = useMemo(() => roomCards(e, answers as Reply[]), [e, answers]);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-6 pb-2 pt-5">
        <div className="text-[15px] font-semibold text-white">Room record</div>
        <div className="text-[12px] text-neutral-500">Shared decisions only. What people say stays in the room.</div>
      </div>
      <RoomTimeline messages={[]} cards={cards} myUserId={null} empty="Nothing decided yet." testId="observer-record" />
    </div>
  );
}

function Resolved({ e }: { e: ConjunctionEvent }) {
  const checks = e.outcome?.checks ?? [];
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      className="shrink-0 overflow-hidden border-b border-[rgba(61,220,151,0.25)] bg-[rgba(61,220,151,0.07)]"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-green">
          <Check size={16} /> Resolved
        </span>
        {checks.slice(0, 4).map((c) => (
          <span key={c.label} className="flex items-center gap-1.5 text-[13px] text-neutral-300">
            {c.ok ? <Check size={12} className="text-green" /> : <X size={12} className="text-[#ff8a80]" />} {c.label}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

function Big({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[12px] text-neutral-500">{label}</div>
      <div className="tnum mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em]" style={{ color: tone ?? "#fff" }}>
        {value}
      </div>
    </div>
  );
}

function Note({ title, body, icon }: { title: string; body: string; icon?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[460px] py-16 text-center">
      {icon && <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-white/[0.05] text-neutral-400">{icon}</div>}
      <div className="text-[17px] font-semibold text-white">{title}</div>
      <p className="mt-2 text-[13.5px] leading-[1.6] text-neutral-500">{body}</p>
    </div>
  );
}
