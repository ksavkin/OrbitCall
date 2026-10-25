"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, MonitorUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CONVEX_AUTH } from "@/lib/backend/provider";
import { useLocalhost } from "@/lib/localhost";
import { fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Reply } from "@/lib/ops/types";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { PcChart } from "@/components/ops/PcChart";
import { stepOf } from "@/components/ops/IncidentView";
import { ProposalPanel } from "@/components/proposals/ProposalPanel";
import { roomCards } from "@/components/roomChat/model";
import { CHANNEL, type PublicView } from "./feed";
import { LiveObserver } from "./LiveObserver";
import { Big, Note, RoomRecord, SimTag, Stepper, TopBar } from "./parts";

// The large display (spec §3.1 `demo.publicView`, role demo_observer): the case, the plans, who approved what
// and the result, for people watching the demo. Read only by construction: no approval, selection, policy,
// agent trace or private message reaches this screen, and nothing on it has a control that acts.
// With the backend and sign-in, it shows the observer's demo run (LiveObserver). The dev feed from an operator tab
// of this browser takes over only while that tab runs Dev, or when this build has no sign-in.

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");

export function ObserverScreen() {
  const now = useNow(1000);
  const local = useLocalhost();
  const { view, settled } = useFeed(local);
  const fresh = !!view && now - view.at < 15_000;

  if (CONVEX_AUTH && !(fresh && view.dev)) {
    // until an operator tab could answer, neither the backend nor the feed is subscribed
    return settled ? (
      <LiveObserver now={now} />
    ) : (
      <div className="flex h-full flex-col bg-black text-neutral-200">
        <TopBar now={now} link={{ text: "Connecting", on: false }} />
      </div>
    );
  }
  return <FeedScreen view={fresh ? view : null} now={now} local={local} />;
}

/** The dev feed from an operator tab of this browser (localhost only). Settled once a tab answered or had time to. */
function useFeed(local: boolean | null) {
  const [view, setView] = useState<PublicView | null>(null);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    if (!local) return;
    // an open operator tab answers "hello" at once
    const t = setTimeout(() => setWaited(true), 500);
    if (typeof BroadcastChannel === "undefined") return () => clearTimeout(t);
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (m) => {
      if (!m.data || m.data === "hello") return;
      const v = m.data as PublicView;
      setView(v);
      // the shared components read events from the store; this tab's store only ever holds the public copy
      if (v.dev) useOps.setState({ events: v.event ? [v.event] : [], replies: v.answers as Reply[], dev: true, autopilot: false });
    };
    ch.postMessage("hello");
    return () => {
      clearTimeout(t);
      ch.close();
    };
  }, [local]);

  return { view, settled: local === false || waited || view !== null };
}

/** The simulator's case as an operator tab of this browser publishes it. */
function FeedScreen({ view, now, local }: { view: PublicView | null; now: number; local: boolean | null }) {
  const e = view?.event ?? null;

  return (
    <div className="flex h-full flex-col bg-black text-neutral-200">
      <TopBar
        head={e && <CaseNames e={e} />}
        tca={e?.tca}
        now={now}
        link={{ text: view ? "Following the operator screen" : "Not connected", on: !!view }}
      />
      <AnimatePresence mode="wait">
        {e ? (
          <motion.div key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
            <Stepper at={stepOf(e)} />
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
              body={
                local === false
                  ? "This build has no sign-in, so it cannot read the demonstration run."
                  : "Open OrbitCall in another tab of this browser, turn on Dev and run a case. This screen follows it, read only. With the backend and sign-in, the same screen reads the demo run's public view."
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CaseNames({ e }: { e: ConjunctionEvent }) {
  return (
    <span className="flex items-center gap-2 text-[14px] text-neutral-300">
      <span className="mono text-neutral-500">{e.id}</span>
      <SideFlag e={e} side="a" /> {e.a.name}
      <span className="text-neutral-600">×</span>
      <SideFlag e={e} side="b" /> {e.b.name}
      {(e.a.synthetic || e.b.synthetic) && <SimTag />}
    </span>
  );
}

/** The dispatcher's country for a side; nothing when the side has no operator (debris). */
function SideFlag({ e, side }: { e: ConjunctionEvent; side: "a" | "b" }) {
  const c = e.parties?.find((p) => p.role === side)?.country;
  return c ? <Flag code={c} h={13} /> : null;
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
  return <RoomRecord cards={cards} empty="Nothing decided yet." />;
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
