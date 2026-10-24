"use client";

import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { Database, ExternalLink, Loader2, RotateCw, ServerCrash, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { agentSummaryRef } from "@/lib/backend/api";
import { fmtAge, fmtObjectId, fmtStamp, pcMetric, pcSource, safeUrl, SOURCE_LABEL } from "@/lib/backend/format";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import type { AgentSummary, Color, EventRow, Pc, SpaceObject } from "@/lib/backend/types";
import { fmtCountdown, fmtMiss, fmtPc, fmtWhen } from "@/lib/ops/format";
import { AGENTS } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import { OWNER_FLAGS } from "@/lib/owners";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Chip } from "@/components/ui/Chip";
import { Flag } from "@/components/ui/OwnerBadge";

// The queue and event detail for backend data (dev switch off). Rows come from
// `events.catalogPairs` in queue order and are shown as given: no re-sorting, no synthetic
// fields. Shapes: src/lib/backend/types.ts (docs/specification.md §2.2).

const TONE: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "var(--fg-2)" };
const RAIL: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "rgba(255,255,255,0.18)" };
const COLOR_LABEL: Record<Color, string> = { red: "Red", yellow: "Yellow", none: "No alert" };

const hasPc = (pc: Pc): pc is Pc & { value: number } => pc.value !== null && Number.isFinite(pc.value);

// Numbers can be missing in real data: say "unknown", never print NaN or throw.
const missText = (row: EventRow) => (Number.isFinite(row.missKm) ? fmtMiss(row.missKm * 1000) : "unknown");
const speedText = (row: EventRow) => (Number.isFinite(row.relSpeedKmS) ? `${row.relSpeedKmS.toFixed(2)} km/s` : "unknown");

/* ------------------------------------------------------------------ list */

/**
 * The list behind a render boundary: a row the backend shapes unexpectedly (a missing field) must
 * not blank the whole app, globe included. Retry remounts it.
 */
export function BackendListSafe({ now }: { now: number }) {
  const epoch = useOps((s) => s.backendEpoch);
  return (
    <QueryBoundary
      key={epoch}
      fallback={(e) => (
        <div className="px-4 py-8 text-center">
          <div className="text-[12px] font-medium">Couldn’t show backend rows</div>
          <p className="mono mt-1 break-words text-[10px] leading-[1.5] text-muted">{briefError(e)}</p>
          <button className="btn btn-ghost-line mt-3 h-7 text-[11px]" onClick={() => useOps.setState((s) => ({ backendEpoch: s.backendEpoch + 1 }))}>
            <RotateCw size={11} /> Retry
          </button>
        </div>
      )}
    >
      <BackendList now={now} />
    </QueryBoundary>
  );
}

function BackendList({ now }: { now: number }) {
  const rows = useOps((s) => s.backendRows);
  const error = useOps((s) => s.backendError);
  const snapshot = useOps((s) => s.backendSnapshot);

  if (error) return <BackendError message={error} />;
  if (!snapshot || snapshot === "error" || !snapshot.ommUrl) {
    return <div className="px-4 py-8 text-center text-[11px] leading-relaxed text-muted">Waiting for the backend OMM catalog. No screening result is available yet.</div>;
  }
  if (rows === undefined) return <LoadingRows />;
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-[11px] leading-[1.5] text-muted">
        No conjunctions in the current catalog snapshot yet.
        <br />
        They appear here as soon as the backend screens one.
      </div>
    );
  }
  return (
    <AnimatePresence initial={false}>
      {rows.map((row) => (
        <motion.div
          key={row.eventId}
          layout="position"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <BackendRow row={row} now={now} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-1 px-1" role="status" aria-label="Loading conjunctions">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-[11px] bg-white/[0.03] px-2.5 py-2.5" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="h-2 w-24 rounded bg-white/[0.07]" />
          <div className="mt-2 h-3 w-44 rounded bg-white/[0.07]" />
          <div className="mt-2 h-2.5 w-32 rounded bg-white/[0.05]" />
        </div>
      ))}
      <div className="px-2 pt-1 text-center text-[10.5px] text-muted">Loading conjunctions…</div>
    </div>
  );
}

function BackendError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-[rgba(255,159,64,0.07)] text-orange shadow-[inset_0_0_0_1px_rgba(255,159,64,0.2)]">
        <ServerCrash size={15} />
      </div>
      <div className="mt-3 text-[12px] font-medium">Couldn’t load conjunctions</div>
      <p className="mono mt-1 max-w-[230px] break-words text-[10px] leading-[1.5] text-muted">{message}</p>
      <button
        className="btn btn-ghost-line mt-3 h-7 text-[11px]"
        onClick={() => {
          sfx.click();
          useOps.setState((s) => ({ backendEpoch: s.backendEpoch + 1, backendError: null, backendSnapshot: undefined, backendRows: undefined }));
        }}
      >
        <RotateCw size={11} /> Retry
      </button>
    </div>
  );
}

/** Where the backend's catalog snapshot was taken (`catalog.snapshot.takenAt`). */
export function BackendSnapshotLine({ now }: { now: number }) {
  const snapshot = useOps((s) => s.backendSnapshot);
  const taken = snapshot && snapshot !== "error" ? Date.parse(snapshot.takenAt) : NaN;
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-[9px] bg-white/[0.03] px-2 py-1.5 text-[10.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <Database size={12} className="shrink-0 text-muted" />
      {snapshot === undefined ? (
        <span className="text-muted">Checking the catalog snapshot…</span>
      ) : snapshot === "error" ? (
        <span className="text-muted">Snapshot status unavailable</span>
      ) : snapshot === null ? (
        <span className="text-muted">No catalog snapshot yet</span>
      ) : (
        <span className="min-w-0 truncate text-muted">
          Snapshot from <span className="mono text-fg-2">{fmtStamp(snapshot.takenAt)}</span>
          {now > 0 && Number.isFinite(taken) && <span className="text-faint"> · {fmtAge(now - taken)}</span>}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- row */

function flagOf(o: SpaceObject): string | null {
  return o.country ? (OWNER_FLAGS[o.country]?.[0] ?? null) : null;
}

function PcInline({ pc, tone }: { pc: Pc; tone: string }) {
  if (!hasPc(pc)) {
    return (
      <span className="text-[10px] font-medium text-muted" title="No source supplied a probability for this pair">
        Pc unavailable
      </span>
    );
  }
  const m = pcMetric(pc);
  return (
    <span className="mono tnum flex items-baseline gap-1" style={{ color: tone }} title={`${m.long} · ${pcSource(pc)}`}>
      {fmtPc(pc.value)}
      <span className="text-[8.5px] uppercase tracking-[0.08em] opacity-70">{m.short}</span>
    </span>
  );
}

function BackendRow({ row, now }: { row: EventRow; now: number }) {
  const focused = useOps((s) => s.focusEvent === row.eventId);
  const tca = Date.parse(row.tcaUtc);
  const tone = TONE[row.color];
  const fa = flagOf(row.objectA);
  const fb = flagOf(row.objectB);
  const working = row.agentsWorking && !row.agentsStalled;

  return (
    <div
      className="group relative mb-1 overflow-hidden rounded-[11px] transition-colors duration-200"
      style={{
        background: focused ? "rgba(255,255,255,0.055)" : undefined,
        boxShadow: focused ? "inset 0 0 0 1px rgba(255,255,255,0.09)" : undefined,
      }}
    >
      {working && <span className="agent-sheen pointer-events-none absolute inset-0 rounded-[11px]" />}
      <button
        className="relative block w-full px-2.5 py-2 text-left transition-colors hover:bg-white/[0.035]"
        aria-expanded={focused}
        onClick={() => {
          sfx.select();
          useOps.getState().set({ focusEvent: focused ? null : row.eventId });
        }}
        onPointerEnter={() => sfx.hover()}
      >
        <span
          className="absolute bottom-2 left-0 top-2 w-[2px] rounded-full"
          style={{ background: RAIL[row.color], boxShadow: row.color === "none" ? undefined : `0 0 8px ${RAIL[row.color]}` }}
        />
        <div className="flex items-center gap-1.5">
          <span className="mono truncate text-[10px] text-muted">
            {fmtObjectId(row.objectA.objectId)} × {fmtObjectId(row.objectB.objectId)}
          </span>
          {row.simulated && <span className="mono shrink-0 text-[8.5px] uppercase tracking-[0.1em] text-orange">sim</span>}
          <span
            className="mono tnum ml-auto shrink-0 text-[10.5px]"
            style={{ color: Number.isFinite(tca) && tca - now < 24 * 3600_000 ? "var(--orange)" : "var(--fg-2)" }}
          >
            {now && Number.isFinite(tca) ? fmtCountdown(tca - now) : "—"}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] font-medium tracking-[-0.005em]">
          {fa && <Flag code={fa} h={10} />}
          <span className="truncate">{row.objectA.name}</span>
          <span className="shrink-0 text-faint">×</span>
          {fb && <Flag code={fb} h={10} />}
          <span className="truncate text-fg-2">{row.objectB.name}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]">
          {row.agentsStalled ? (
            <Chip color="var(--orange)" size="sm" icon={<TriangleAlert size={9} />}>
              Agents stalled
            </Chip>
          ) : row.agentsWorking ? (
            <Chip color="var(--blue)" size="sm" icon={<Loader2 size={9} className="animate-spin" />}>
              Agents working
            </Chip>
          ) : (
            <Chip color={row.color === "none" ? "var(--muted)" : tone} size="sm">
              {COLOR_LABEL[row.color]}
            </Chip>
          )}
          <span className="mono tnum text-fg-2">{missText(row)}</span>
          <PcInline pc={row.pc} tone={tone} />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {focused && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <BackendDetail row={row} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

function BackendDetail({ row }: { row: EventRow }) {
  const tca = Date.parse(row.tcaUtc);
  const tone = TONE[row.color];
  const pc = row.pc;
  const m = pcMetric(pc);
  const pcUrl = safeUrl(pc.sourceUrl);
  return (
    <div className="px-2.5 pb-2.5">
      <div className="grid grid-cols-2 overflow-hidden rounded-[9px] bg-white/[0.025] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
        <Stat label="Miss distance" value={missText(row)} />
        <Stat
          label="Probability"
          value={hasPc(pc) ? fmtPc(pc.value) : "Pc unavailable"}
          hint={hasPc(pc) ? `${m.long}${pc.source === "socrates" ? "" : ` · ${pcSource(pc)}`}` : "No source supplied one"}
          tone={hasPc(pc) ? tone : "var(--muted)"}
          title={hasPc(pc) ? `${m.long} · ${pcSource(pc)} · epoch ${fmtStamp(pc.epochUtc)}` : undefined}
          border
        />
        <Stat label="Rel. velocity" value={speedText(row)} top />
        <Stat label="TCA" value={Number.isFinite(tca) ? fmtWhen(tca) : "—"} hint={fmtStamp(row.tcaUtc)} top border />
      </div>

      {(pcUrl || pc.emergencyReportable) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px]">
          {pc.emergencyReportable && (
            <Chip color="var(--orange)" size="sm">
              Emergency reportable
            </Chip>
          )}
          {pcUrl && (
            <a className="ml-auto inline-flex items-center gap-1 text-muted hover:text-fg" href={pcUrl} target="_blank" rel="noopener noreferrer">
              Verify Pc source <ExternalLink size={9} />
            </a>
          )}
        </div>
      )}

      <div className="mt-2.5 space-y-1.5">
        <ObjectLine o={row.objectA} dot="#9cc2ff" />
        <ObjectLine o={row.objectB} dot="#a594ff" />
      </div>

      {(row.sources?.length ?? 0) > 0 && (
        <div className="mt-2.5">
          <span className="eyebrow">Sources</span>
          <ul className="mt-1 space-y-0.5">
            {row.sources.map((s, i) => {
              const url = safeUrl(s.url);
              const label = SOURCE_LABEL[s.name] ?? s.name;
              return (
                <li key={`${s.name}-${i}`} className="flex items-baseline gap-1.5 text-[10px] leading-[1.45]">
                  {url ? (
                    <a className="inline-flex shrink-0 items-center gap-0.5 text-fg-2 hover:text-fg" href={url} target="_blank" rel="noopener noreferrer">
                      {label} <ExternalLink size={8} />
                    </a>
                  ) : (
                    <span className="shrink-0 text-fg-2">{label}</span>
                  )}
                  <span className="mono min-w-0 break-words text-[9.5px] text-faint">
                    {s.epochUtc ? `epoch ${fmtStamp(s.epochUtc)}` : ""}
                    {s.epochUtc && s.fetchedAt ? " · " : ""}
                    {s.fetchedAt ? `fetched ${fmtStamp(s.fetchedAt)}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <AnalystSection eventId={row.eventId} color={row.color} />
    </div>
  );
}

function Stat({ label, value, hint, border, top, tone, title }: { label: string; value: string; hint?: string; border?: boolean; top?: boolean; tone?: string; title?: string }) {
  return (
    <div className={`min-w-0 px-2 py-1.5 ${border ? "border-l border-white/[0.055]" : ""} ${top ? "border-t border-white/[0.055]" : ""}`} title={title}>
      <div className="text-[9.5px] text-muted">{label}</div>
      <div className="mono tnum mt-0.5 truncate text-[12px] font-medium" style={{ color: tone }}>
        {value}
      </div>
      {hint && <div className="mono break-words text-[9.5px] leading-[1.35] text-faint">{hint}</div>}
    </div>
  );
}

function ObjectLine({ o, dot }: { o: SpaceObject; dot: string }) {
  const flag = flagOf(o);
  const celestrak = safeUrl(o.celestrakUrl);
  // country and launch date are null for a share of real objects: say so, never blank or crash
  const owner = [o.ownerName, o.country].filter(Boolean).join(" · ") || "owner unknown";
  const meta = [owner, o.purpose, o.launchDate ? `launched ${o.launchDate}` : "launch date unknown"].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: dot }} />
        {flag && <Flag code={flag} h={10} />}
        <span className="truncate font-medium">{o.name}</span>
        {celestrak ? (
          <a className="mono inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted hover:text-fg" href={celestrak} target="_blank" rel="noopener noreferrer" title="Verify on CelesTrak">
            {fmtObjectId(o.objectId)} <ExternalLink size={8} />
          </a>
        ) : (
          <span className="mono shrink-0 text-[10px] text-muted">{fmtObjectId(o.objectId)}</span>
        )}
        {o.simulated && <span className="mono shrink-0 text-[8.5px] uppercase tracking-[0.1em] text-orange">sim</span>}
      </div>
      {meta && <div className="truncate pl-[13px] text-[9.5px] text-faint">{meta}</div>}
    </div>
  );
}

/* --------------------------------------------------------- analyst summary */

function AnalystSection({ eventId, color }: { eventId: string; color: Color }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="mt-2.5" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Summary</span>
        <span className="text-[9.5px] text-faint">{AGENTS.analyst.name}</span>
      </div>
      <QueryBoundary
        key={attempt}
        fallback={(e) => (
          <Notice tone="var(--orange)" icon={<TriangleAlert size={11} />} title="Summary unavailable">
            <span className="mono break-words text-[10px] text-muted">{briefError(e)}</span>
            <button className="btn btn-ghost-line mt-1.5 h-6 text-[11px]" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCw size={11} /> Retry
            </button>
          </Notice>
        )}
      >
        <AnalystSummary eventId={eventId} color={color} />
      </QueryBoundary>
    </div>
  );
}

function AnalystSummary({ eventId, color }: { eventId: string; color: Color }) {
  const s = useQuery(agentSummaryRef, { eventId });
  const now = useNow(1000);
  return <SummaryView s={s} color={color} now={now} />;
}

/** The summary states for one event: loading, checked five lines, working, stalled, failed, empty. */
export function SummaryView({ s, color, now }: { s: AgentSummary | undefined; color: Color; now: number }) {
  if (s === undefined) {
    return (
      <div className="mt-1.5 animate-pulse space-y-1.5" role="status" aria-label="Loading summary">
        {[88, 72, 80].map((w) => (
          <div key={w} className="h-2 rounded bg-white/[0.06]" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }

  // Only a checked summary is ever shown as a normal summary (AGT-5).
  if (s.numbersChecked && s.summaryLines.length > 0) {
    return (
      <div className="mt-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip color="var(--green)" size="sm" icon={<ShieldCheck size={9} />}>
            Numbers checked
          </Chip>
          {s.simulated && (
            <Chip color="var(--orange)" size="sm">
              Simulated incident
            </Chip>
          )}
          {s.agentsStalled ? (
            <Chip color="var(--orange)" size="sm" icon={<TriangleAlert size={9} />}>
              Stalled
            </Chip>
          ) : (
            s.agentsWorking && (
              <Chip color="var(--blue)" size="sm" icon={<Loader2 size={9} className="animate-spin" />}>
                Updating
              </Chip>
            )
          )}
          <span className="mono ml-auto text-[9.5px] text-faint">{fmtStamp(s.createdAt)}</span>
        </div>
        <ol className="mt-1.5 space-y-1">
          {s.summaryLines.map((l, i) => (
            <motion.li
              key={`${i}-${l}`}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.25 }}
              className="flex gap-1.5 text-[10.5px] leading-[1.45] text-fg-2"
            >
              <span className="mono mt-px shrink-0 text-[9.5px] text-faint">{i + 1}</span>
              <span>{l}</span>
            </motion.li>
          ))}
        </ol>
      </div>
    );
  }

  const run = s.run;
  const since = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return now > 0 && Number.isFinite(t) ? fmtAge(now - t) : "";
  };

  if (s.agentsStalled) {
    return (
      <Notice tone="var(--orange)" icon={<TriangleAlert size={11} />} title="Analyst stalled">
        No progress for over 60 s{run ? ` (last ${since(run.lastProgressAt)}, stage ${run.stage.replace(/_/g, " ")})` : ""}. The call may still finish on its
        own; a re-run has to be started from the backend.
      </Notice>
    );
  }
  if (s.agentsWorking) {
    return (
      <Notice tone="var(--blue)" icon={<Loader2 size={11} className="animate-spin" />} title="Analyst is working">
        {run ? (
          <>
            <span className="mono">{run.stage.replace(/_/g, " ")}</span> · started {since(run.startedAt)}
            {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
          </>
        ) : (
          "Preparing the checked five-line summary."
        )}
      </Notice>
    );
  }
  if (run?.status === "failed") {
    return (
      <Notice tone="var(--red)" icon={<TriangleAlert size={11} />} title="Analyst run failed">
        {run.errorCode && <span className="mono text-[10px] text-red">{run.errorCode}</span>}
        {run.errorMessage && <span className="block">{run.errorMessage}</span>}
        <span className="block text-faint">No summary is shown unless every number in it was checked.</span>
      </Notice>
    );
  }
  return (
    <Notice tone="var(--muted)" title="No summary yet">
      {color === "red"
        ? "The Incident Analyst has not published a checked summary for this event."
        : "The Incident Analyst runs when an event turns red."}
    </Notice>
  );
}

function Notice({ tone, icon, title, children }: { tone: string; icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div
      className="mt-1.5 rounded-[9px] p-2 text-[10.5px] leading-[1.45] text-fg-2"
      style={{
        background: `color-mix(in srgb, ${tone} 7%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 20%, transparent)`,
      }}
    >
      <div className="mb-0.5 flex items-center gap-1.5 font-medium" style={{ color: tone }}>
        {icon} {title}
      </div>
      {children}
    </div>
  );
}
