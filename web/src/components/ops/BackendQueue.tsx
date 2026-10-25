"use client";

import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Database, ExternalLink, Loader2, RotateCw, ServerCrash, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentSummaryRef } from "@/lib/backend/api";
import { fmtAge, fmtObjectId, fmtStamp, pcMetric, pcSource, safeUrl, SOURCE_LABEL } from "@/lib/backend/format";
import { openCase, useLive } from "@/lib/backend/live";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import type { AgentSummary, Color, EventRow, MyQueueRow, Pc, SpaceObject } from "@/lib/backend/types";
import { fmtCountdown, fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { AGENTS } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import { OWNER_FLAGS } from "@/lib/owners";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Chip } from "@/components/ui/Chip";
import { useMe } from "@/components/auth/session";
import { retryQueueSync, useQueueSync } from "@/components/live/sync/QueueSync";
import { applyView, queueSections, useQueueView, type QueueSection } from "./queueView";
import { Flag } from "@/components/ui/OwnerBadge";

// The queue and event detail for backend data (dev switch off). Rows come from
// `events.catalogPairs` in queue order; the dispatcher can search, filter and re-sort them
// (queueView.ts), and never sees synthetic fields. Shapes: src/lib/backend/types.ts (docs/specification.md §2.2).
// My Incidents (bottom of the file) is the operator's own queue, `myQueue.myQueue`: the one real mode shows.

const TONE: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "var(--fg-2)" };
const RAIL: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "rgba(255,255,255,0.18)" };
const COLOR_LABEL: Record<Color, string> = { red: "Red", yellow: "Yellow", none: "No alert" };

const hasPc = (pc: Pc): pc is Pc & { value: number } => pc.value !== null && Number.isFinite(pc.value);

/** The row of the pair the globe is showing. */
const focusStyle = (focused: boolean) =>
  focused ? { background: "rgba(255,255,255,0.055)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.09)" } : undefined;

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
  return <PagedRows now={now} />;
}

const PAGE = 50;

/** The queue as the dispatcher filtered and sorted it (minute resolution for the time filters). */
export function useBackendView(now: number) {
  const rows = useOps((s) => s.backendRows);
  const view = useQueueView();
  const me = useMe();
  const minute = Math.floor(now / 60_000);
  const fleet = useMemo(() => new Set(me?.assignedObjectIds ?? []), [me]);
  const list = useMemo(() => (rows ? applyView(rows, view, fleet, minute * 60_000) : undefined), [rows, view, fleet, minute]);
  return { all: rows, list };
}

/**
 * The filtered queue, 50 rows at a time: reaching the bottom loads the next 50 with a spinner while they render.
 * Rendering all ~1,000 rows at once would stall the globe; the data itself is already here.
 */
function PagedRows({ now }: { now: number }) {
  const { list } = useBackendView(now);
  const view = useQueueView();
  const [count, setCount] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const key = `${view.search}|${view.sort}|${view.severity}|${view.within}|${view.objects}|${view.mine}`;
  const [seen, setSeen] = useState(key);
  // a new search or filter starts again from the top
  if (seen !== key) {
    setSeen(key);
    setCount(PAGE);
  }
  const total = list?.length ?? 0;
  const more = count < total;

  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      ([hit]) => {
        if (!hit.isIntersecting || timer) return;
        setLoading(true);
        // let the spinner paint before the next 50 rows render
        timer = setTimeout(() => {
          setCount((c) => c + PAGE);
          setLoading(false);
          timer = null;
        }, 160);
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [more, count]);

  if (!list) return <LoadingRows />;
  if (total === 0) return <NoMatches mine={view.mine} />;
  return (
    <div>
      {list.slice(0, count).map((row, i) => (
        <motion.div
          key={row.eventId}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, delay: Math.min(i % PAGE, 12) * 0.015, ease: [0.22, 1, 0.36, 1] }}
        >
          <BackendRow row={row} now={now} />
        </motion.div>
      ))}
      <div ref={end} className="flex h-10 items-center justify-center text-[10.5px] text-muted">
        {more ? (
          loading ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading more
            </span>
          ) : (
            <span className="tnum">
              {Math.min(count, total).toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            </span>
          )
        ) : (
          <span className="tnum">All {total.toLocaleString("en-US")} shown</span>
        )}
      </div>
    </div>
  );
}

function NoMatches({ mine }: { mine: boolean }) {
  const reset = useQueueView((s) => s.reset);
  return (
    <div className="px-4 py-8 text-center">
      <div className="text-[12px] font-medium">{mine ? "None of your satellites is in these results" : "No conjunctions match"}</div>
      <p className="mt-1 text-[11px] leading-[1.5] text-muted">{mine ? "Your fleet has no conjunction with these filters." : "Try a wider time window or clear the filters."}</p>
      <button className="btn btn-ghost-line mt-3 h-7 text-[11px]" onClick={() => reset()}>
        Show the whole queue
      </button>
    </div>
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
      {fmtOdds(pc.value)}
      <span className="text-[8.5px] uppercase tracking-[0.08em] opacity-70">{m.short}</span>
    </span>
  );
}

function BackendRow({ row, now }: { row: EventRow; now: number }) {
  const focused = useOps((s) => s.focusEvent === row.eventId);
  const working = row.agentsWorking && !row.agentsStalled;

  return (
    <div className="group relative mb-1 overflow-hidden rounded-[11px] transition-colors duration-200" style={focusStyle(focused)}>
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
        <RowFace row={row} pair={[row.objectA, row.objectB]} now={now} />
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

/** A queue row's face: both objects in `pair` order, time until closest approach, state, miss and Pc. */
function RowFace({ row, pair: [a, b], now, review = false }: { row: EventRow; pair: [SpaceObject, SpaceObject]; now: number; review?: boolean }) {
  const tca = Date.parse(row.tcaUtc);
  // under a day to go reads orange; a passed approach (history) does not
  const soon = Number.isFinite(tca) && tca >= now && tca - now < 24 * 3600_000;
  const tone = TONE[row.color];
  const fa = flagOf(a);
  const fb = flagOf(b);
  return (
    <>
      <span
        className="absolute bottom-2 left-0 top-2 w-[2px] rounded-full"
        style={{ background: RAIL[row.color], boxShadow: row.color === "none" ? undefined : `0 0 8px ${RAIL[row.color]}` }}
      />
      <div className="flex items-center gap-1.5">
        <span className="mono truncate text-[10px] text-muted">
          {fmtObjectId(a.objectId)} × {fmtObjectId(b.objectId)}
        </span>
        <span className="mono tnum ml-auto shrink-0 text-[10.5px]" style={{ color: soon ? "var(--orange)" : "var(--fg-2)" }}>
          {now && Number.isFinite(tca) ? fmtCountdown(tca - now) : "—"}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] font-medium tracking-[-0.005em]">
        {fa && <Flag code={fa} h={10} />}
        <span className="truncate">{a.name}</span>
        <span className="shrink-0 text-faint">×</span>
        {fb && <Flag code={fb} h={10} />}
        <span className="truncate text-fg-2">{b.name}</span>
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
        ) : review ? (
          // no probability is not "no alert": the risk is unknown until the data is reviewed
          <Chip color="var(--orange)" size="sm">
            Needs review
          </Chip>
        ) : (
          <Chip color={row.color === "none" ? "var(--muted)" : tone} size="sm">
            {COLOR_LABEL[row.color]}
          </Chip>
        )}
        <span className="mono tnum text-fg-2">{missText(row)}</span>
        <PcInline pc={row.pc} tone={tone} />
      </div>
    </>
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
          value={hasPc(pc) ? fmtOdds(pc.value) : "Chance unavailable"}
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

/* ------------------------------------------------------ my incidents (real mode) */

const SECTION_LABEL: Record<QueueSection, string> = { active: "Active", data_review: "Data needs review", history: "History" };
/** Rows a section shows before "Show more": open incidents are few, history keeps growing. */
const SECTION_PAGE = 20;

/**
 * The operator's own incidents (`myQueue.myQueue`, kept in useLive by QueueSync): the events that involve their fleet,
 * in the backend's sections and rank, each with the backend's reason for its place. A row opens the case in the
 * Decision Center; the globe flies to the pair as it does from any queue row. Real mode only, under My Fleet.
 */
export function MyIncidents() {
  const rows = useLive((s) => s.myQueue);
  const error = useQueueSync((s) => s.errors.myQueue);
  const sections = useMemo(() => (rows ? queueSections(rows) : undefined), [rows]);
  const open = sections ? sections.active.length + sections.data_review.length : 0;
  const red = sections ? sections.active.filter((r) => r.color === "red").length : 0;

  return (
    <motion.section
      initial={{ opacity: 0, x: -16, filter: "blur(8px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: -16, filter: "blur(8px)" }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="glass pointer-events-auto relative flex max-h-[360px] min-h-0 shrink flex-col overflow-hidden rounded-[14px]"
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <span className="eyebrow">My incidents</span>
        {sections && !error && (
          <span className="text-[11px] text-muted">
            <span className="mono tnum text-fg-2">{open}</span> open
            {red > 0 && (
              <>
                {" · "}
                <span className="text-red">
                  <span className="mono tnum">{red}</span> red
                </span>
              </>
            )}
          </span>
        )}
      </div>
      <div className="mx-3 h-px bg-white/[0.06]" />
      <div className="thin-scroll min-h-0 overflow-y-auto px-1.5 py-1.5">
        {error ? (
          <IncidentsError message={error.message} retry={error.code !== "FORBIDDEN"} />
        ) : sections ? (
          <Sections sections={sections} />
        ) : (
          <LoadingRows />
        )}
      </div>
    </motion.section>
  );
}

function Sections({ sections }: { sections: Record<QueueSection, MyQueueRow[]> }) {
  const now = useNow(1000);
  const open = sections.active.length + sections.data_review.length;
  if (open === 0 && sections.history.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <div className="text-[12px] font-medium">No incidents for your fleet</div>
        <p className="mt-1 text-[11px] leading-[1.5] text-muted">Run a scan to check your satellites against the catalog for the next 72 hours.</p>
      </div>
    );
  }
  return (
    <>
      {open === 0 && <p className="px-2 pb-1 pt-1.5 text-[11px] leading-[1.5] text-muted">No open incidents for your fleet.</p>}
      <Section id="active" rows={sections.active} now={now} />
      <Section id="data_review" rows={sections.data_review} now={now} />
      <Section id="history" rows={sections.history} now={now} collapsible />
    </>
  );
}

function Section({ id, rows, now, collapsible = false }: { id: QueueSection; rows: MyQueueRow[]; now: number; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  const [count, setCount] = useState(SECTION_PAGE);
  if (rows.length === 0) return null;
  const head = (
    <>
      <span className="eyebrow">{SECTION_LABEL[id]}</span>
      <span className="mono tnum ml-auto text-[10px] text-muted">{rows.length}</span>
      {collapsible && <ChevronDown size={11} className={`shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} />}
    </>
  );
  return (
    <div className="mb-1">
      {collapsible ? (
        <button
          className="flex w-full items-center gap-1.5 rounded-[7px] px-2 pb-1 pt-1.5 text-left transition-colors hover:bg-white/[0.035]"
          aria-expanded={open}
          onClick={() => {
            sfx.click();
            setOpen((o) => !o);
          }}
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">{head}</div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <AnimatePresence>
              {rows.slice(0, count).map((row, i) => (
                <motion.div
                  key={row.eventId}
                  layout="position"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.28, delay: Math.min(i, 12) * 0.015, ease: [0.22, 1, 0.36, 1] }}
                >
                  <QueueRow row={row} now={now} review={id === "data_review"} />
                </motion.div>
              ))}
            </AnimatePresence>
            {rows.length > count && (
              <button
                className="flex h-8 w-full items-center justify-center text-[10.5px] text-muted transition-colors hover:text-fg"
                onClick={() => {
                  sfx.click();
                  setCount((c) => c + SECTION_PAGE);
                }}
              >
                Show {Math.min(SECTION_PAGE, rows.length - count)} more
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One incident: the operator's object first, then the other, and the backend's reason for its rank. */
function QueueRow({ row, now, review }: { row: MyQueueRow; now: number; review: boolean }) {
  const focused = useOps((s) => s.focusEvent === row.eventId);
  const working = row.agentsWorking && !row.agentsStalled;
  const mineIsB = row.myObjectIds.includes(row.objectB.objectId) && !row.myObjectIds.includes(row.objectA.objectId);

  return (
    <div className="group relative mb-1 overflow-hidden rounded-[11px] transition-colors duration-200" style={focusStyle(focused)}>
      {working && <span className="agent-sheen pointer-events-none absolute inset-0 rounded-[11px]" />}
      <button
        className="relative block w-full px-2.5 py-2 text-left transition-colors hover:bg-white/[0.035]"
        onClick={() => {
          sfx.select();
          openCase(row.eventId);
        }}
        onPointerEnter={() => sfx.hover()}
      >
        <RowFace row={row} pair={mineIsB ? [row.objectB, row.objectA] : [row.objectA, row.objectB]} now={now} review={review} />
        <p className="mt-1.5 break-words text-[10px] leading-[1.45] text-muted">{row.priorityReason}</p>
      </button>
    </div>
  );
}

function IncidentsError({ message, retry }: { message: string; retry: boolean }) {
  return (
    <div className="flex flex-col items-center px-4 py-6 text-center">
      <div className="text-[12px] font-medium">Couldn’t load your incidents</div>
      <p className="mt-1 max-w-[220px] break-words text-[11px] leading-[1.5] text-muted">{message}</p>
      {retry && (
        <button className="btn btn-ghost-line mt-3 h-7 text-[11px]" onClick={() => retryQueueSync()}>
          <RotateCw size={11} /> Retry
        </button>
      )}
    </div>
  );
}
