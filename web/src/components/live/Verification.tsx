"use client";

import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { verificationReplayRef, verificationRequestRef } from "@/lib/backend/api";
import { diffForSelection, selectedCard } from "@/lib/backend/decision";
import { backendError } from "@/lib/backend/errors";
import { fmtStamp, safeUrl, SOURCE_LABEL } from "@/lib/backend/format";
import { useLive, useRealMode } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { act } from "@/lib/backend/run";
import type { EventId, Verification, VerificationResult } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";
import { useNow } from "@/lib/useNow";
import { Chip } from "@/components/ui/Chip";

// After a committed schedule (wiring map §9, §1.5): request verification, then show what later public element sets
// say. A scheduled burn is never "executed"; the best result is "evidence consistent with plan", with the method,
// thresholds, limitations and sources beside it (VER-1, VER-2, VER-4). The bundled replay is simulated and is only
// ever shown under that label (VER-3).

const RESULT: Record<VerificationResult, { text: string; color: string }> = {
  consistent: { text: "Evidence consistent with plan", color: "var(--green)" },
  mismatch: { text: "Mismatch", color: "var(--red)" },
  awaiting_data: { text: "Awaiting verification data", color: "var(--fg-2)" },
};

const FRAME = "rounded-[12px] bg-black/25 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]";
const ease = [0.22, 1, 0.36, 1] as const;

/** Signed change in semi-major axis: "+420 m", "−1.25 km". */
function fmtDa(km: number): string {
  const sign = km > 0 ? "+" : km < 0 ? "−" : "";
  const a = Math.abs(km);
  return a < 1 ? `${sign}${Math.round(a * 1000)} m` : `${sign}${a.toFixed(2)} km`;
}

/** verifications.request errors carry a message for users; a non-backend failure gets a plain one. */
function requestError(e: unknown): string {
  const { code, message } = backendError(e);
  return code === "UNKNOWN" ? "The verification request did not complete. Retry later." : message;
}

export function VerificationPanel({ eventId }: { eventId: EventId }) {
  const real = useRealMode();
  const open = useOps((s) => s.incident === eventId);
  const verification = useLive((s) => s.verification);
  const error = useLive((s) => s.errors.verification);
  const maneuver = useLive((s) => s.maneuver);
  const approvals = useLive((s) => s.approvals);
  const cards = useLive((s) => s.proposals);
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  if (!real || !open) return null;

  const m = diffForSelection(maneuver, approvals);
  const committed = m?.status === "committed";
  const review = (committed && m.reviewRequired) || verification?.reviewRequired === true;
  if (!committed && !verification && !error) return null;

  const burn = selectedCard(approvals, cards)?.latest.burnTimeUtc ?? null;
  const beforeBurn = burn !== null && now > 0 && Date.parse(burn) > now;
  const canRequest = committed && !review && (!verification || verification.result === "awaiting_data");

  async function request() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      const r = await act(verificationRequestRef, { eventId });
      if (r.reused) setNote({ error: false, text: "Same result as the last check." });
    } catch (e) {
      setNote({ error: true, text: requestError(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={FRAME} data-testid="verification">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11.5px] text-neutral-500">Verification</span>
        {verification && <ResultChips v={verification} />}
        {review && <Chip color="var(--orange)" size="sm">Scheduled artifact needs review</Chip>}
        {verification && <span className="tnum ml-auto text-[11px] text-neutral-600">Checked {fmtStamp(verification.createdAt)}</span>}
      </div>

      {error ? (
        <p className="mt-1.5 text-[12.5px] text-[#ff8a80]">Verification could not be read · {error}</p>
      ) : verification === undefined ? (
        <p className="shimmer mt-1.5 text-[12.5px] text-neutral-500">Reading the verification record…</p>
      ) : verification ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease }}>
          <Evidence v={verification} />
        </motion.div>
      ) : (
        <p className="mt-1 text-[13px] leading-[1.55] text-neutral-300">
          Scheduled{m?.commitSha && <span className="mono text-neutral-400"> (commit {m.commitSha.slice(0, 8)})</span>}. Not evidence of execution.{" "}
          <span className="text-neutral-500">Later public element sets can show whether the orbit changed as planned.</span>
        </p>
      )}

      {review && <p className="mt-1.5 text-[12.5px] text-neutral-500">Inputs changed after the schedule was written. Verification waits until it is reviewed.</p>}
      {canRequest && beforeBurn && <p className="tnum mt-1.5 text-[12.5px] text-neutral-500">The burn is at {fmtStamp(burn)}. Evidence can only appear after it.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canRequest && (
          <button className={`btn ${verification ? "btn-ghost-line" : "btn-primary"} h-8 gap-1.5 px-3.5 text-[12px]`} disabled={busy} onClick={request}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : verification ? <RotateCcw size={12} /> : <ShieldCheck size={12} />}
            {busy ? "Comparing element sets…" : verification ? "Check again" : "Request verification"}
          </button>
        )}
        {note && <span className={`min-w-0 text-[12px] ${note.error ? "text-[#ff8a80]" : "text-neutral-500"}`}>{note.text}</span>}
        <ReplayToggle />
      </div>
    </div>
  );
}

/** The result, and "Simulated" when the evidence is (the replay's own frame already says so). */
function ResultChips({ v, simulated = true }: { v: Verification; simulated?: boolean }) {
  const r = RESULT[v.result];
  return (
    <>
      <Chip color={r.color} size="sm">
        {r.text}
      </Chip>
      {simulated && v.simulated && (
        <Chip color="var(--orange)" size="sm">
          Simulated
        </Chip>
      )}
    </>
  );
}

/** Promised against observed, then how it was judged and what it rests on. Shared by the live result and the replay. */
function Evidence({ v }: { v: Verification }) {
  const t = v.thresholds;
  const extra = v.label.trim().toLowerCase() !== RESULT[v.result].text.toLowerCase();
  const rule = `A change counts at |z| ≥ ${t.z} and |Δa| ≥ ${Math.round(t.minDeltaAKm * 1000)} m. It is consistent when the sign matches and the size is within ±${Math.round(t.sizeTolerance * 100)}% of the plan.`;
  return (
    <div className="mt-2 space-y-3">
      {extra && <p className="text-[12.5px] text-neutral-400">{v.label}</p>}
      {v.result === "mismatch" && <p className="text-[12.5px] text-[#ff8a80]">The observed change differs from the plan in sign or size.</p>}
      <div className="grid grid-cols-4 overflow-hidden rounded-[9px] bg-white/[0.025] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
        <Fact label="Expected Δa" value={fmtDa(v.expected.deltaAKm)} hint="planned change in orbit size" />
        <Fact label="Observed Δa" value={v.observed ? fmtDa(v.observed.deltaAKm) : "—"} hint={v.observed ? `around ${fmtStamp(v.observed.epochUtc)}` : "not measured yet"} border />
        <Fact label="z-score" value={v.observed ? v.observed.z.toFixed(1) : "—"} hint={`counts at |z| ≥ ${t.z}`} border />
        <Fact label="Element sets" value={String(v.elementSetCount)} hint={`${t.minSets} needed`} border />
      </div>
      <p className="text-[12px] leading-[1.55] text-neutral-500">{rule}</p>
      <Block title="Method">
        <p className="break-words">{v.method}</p>
      </Block>
      {v.missing.length > 0 && <List title="Missing" items={v.missing} dot="var(--amber)" />}
      {v.limitations.length > 0 && <List title="Limitations" items={v.limitations} dot="var(--faint)" />}
      {v.sources.length > 0 && <Sources v={v} />}
    </div>
  );
}

function Fact({ label, value, hint, border }: { label: string; value: string; hint: string; border?: boolean }) {
  return (
    <div className={`min-w-0 px-3 py-2 ${border ? "border-l border-white/[0.055]" : ""}`}>
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className="mono tnum mt-0.5 truncate text-[13px] font-medium text-white">{value}</div>
      <div className="break-words text-[11px] leading-[1.35] text-neutral-600">{hint}</div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="text-[12.5px] leading-[1.55] text-neutral-400">
      <div className="mb-0.5 text-[11px] text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function List({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <Block title={title}>
      <ul className="space-y-0.5">
        {items.map((x, i) => (
          <li key={`${i}-${x}`} className="flex items-start gap-2">
            <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full" style={{ background: dot }} />
            <span className="min-w-0 break-words">{x}</span>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Sources({ v }: { v: Verification }) {
  return (
    <Block title="Sources">
      <ul className="space-y-0.5">
        {v.sources.map((s, i) => {
          const url = safeUrl(s.url);
          const label = SOURCE_LABEL[s.name] ?? s.name;
          return (
            <li key={`${s.name}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5">
              {url ? (
                <a className="inline-flex shrink-0 items-center gap-0.5 text-neutral-300 hover:text-white" href={url} target="_blank" rel="noopener noreferrer">
                  {label} <ExternalLink size={9} />
                </a>
              ) : (
                <span className="shrink-0 text-neutral-300">{label}</span>
              )}
              <span className="mono min-w-0 break-words text-[11px] text-neutral-600">
                {[s.epochUtc && `epoch ${fmtStamp(s.epochUtc)}`, s.fetchedAt && `fetched ${fmtStamp(s.fetchedAt)}`].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

/* ---------------------------------------------------------------- the simulated replay (VER-3) */

function ReplayToggle() {
  const [show, setShow] = useState(false);
  return (
    <>
      <button className="btn btn-ghost-line ml-auto h-8 px-3 text-[12px]" aria-expanded={show} onClick={() => setShow((x) => !x)}>
        {show ? "Hide the simulated replay" : "Show the simulated replay"}
      </button>
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="replay"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease }}
            className="basis-full overflow-hidden"
          >
            <div className="mt-1 rounded-[10px] bg-[rgba(255,159,64,0.04)] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,159,64,0.22)]" data-testid="verification-replay">
              <div className="flex flex-wrap items-center gap-2">
                <Chip color="var(--orange)" size="sm">
                  Simulated replay
                </Chip>
                <span className="text-[12px] text-neutral-500">Bundled simulated observations that show the method. Not evidence for this incident.</span>
              </div>
              <QueryBoundary fallback={(e) => <p className="mt-2 text-[12.5px] text-[#ff8a80]">The replay could not be read · {briefError(e)}</p>}>
                <ReplayRead />
              </QueryBoundary>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ReplayRead() {
  const r = useQuery(verificationReplayRef, {});
  if (r === undefined) return <p className="shimmer mt-2 text-[12.5px] text-neutral-500">Reading the replay…</p>;
  if (r === null) return <p className="mt-2 text-[12.5px] text-neutral-500">No simulated replay is stored yet.</p>;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ResultChips v={r} simulated={false} />
      </div>
      <Evidence v={r} />
    </>
  );
}
