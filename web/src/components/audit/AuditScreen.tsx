"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMe, useSession } from "@/components/auth/session";
import { Chip } from "@/components/ui/Chip";
import { Select } from "@/components/ui/Popover";
import { ScreenFrame, ScreenMessage } from "@/components/ui/ScreenFrame";
import { fmtUtc } from "@/lib/format";
import {
  acceptSmokeInvite,
  isSmokeDemo,
  readSmokeInvite,
  smokeSideFor,
  subscribeSmokeInvites,
} from "@/lib/ops/smoke";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";
import { AUDIT_ACTION, auditEntries, defaultPeriod, periodBounds, type AuditEntry } from "./fromEvents";

const PAGE = 50;

const input =
  "h-8 rounded-[8px] bg-white/[0.045] px-2.5 text-[12px] text-white outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] [color-scheme:dark] focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]";

// Shared history plus the company report draft. Counts stay blank until reports.preview exists:
// a zero here would be an invented count (LOG-8). Simulated cases are listed, then left out of the draft (LOG-7).

export function AuditScreen() {
  const userId = useSession((s) => s.userId);
  const me = useMe();

  return (
    <ScreenFrame label="Inbox">
      {userId === undefined ? (
        <ScreenMessage title="Checking sign-in" body="The log is for the companies in a case. Confirming who is signed in." />
      ) : !me ? (
        <ScreenMessage
          title="Sign in to read the log"
          body="Messages, selections, approvals and verification are shared with the people on the case. Policy numbers are not in this log."
          action={
            <Link href="/signin" className="btn btn-primary h-9 px-3 text-[13px]" onClick={() => sfx.click()}>
              Sign in
            </Link>
          }
        />
      ) : me.role === "demo_observer" || !me.company ? (
        <ScreenMessage title="No company log" body="The observer display stays read only. This log belongs to the companies on the case." />
      ) : (
        <AuditBody companyName={me.company.name} />
      )}
    </ScreenFrame>
  );
}

/** What needs this dispatcher: decisions due, cases they were added to, cases that closed. Newest first. */
function Notices() {
  const events = useOps((s) => s.events);
  const humans = useOps((s) => s.humans);
  const viewer = useOps((s) => s.actAs ?? "a");
  const resolved = useOps((s) => s.resolved);
  const me = useMe();
  const [smokeInvite, setSmokeInvite] = useState(() => (isSmokeDemo() ? readSmokeInvite() : null));
  useEffect(() => {
    if (!isSmokeDemo()) return;
    return subscribeSmokeInvites((inv) => setSmokeInvite(inv));
  }, []);
  const items = useMemo(() => {
    const out: { id: string; at: number; tone: "due" | "info" | "ok" | "accept"; title: string; detail: string; eventId: string }[] = [];
    const smokeSide = smokeSideFor(me?.userId);
    // CN / RU smoke guests: Accept joins the Decision Center and the case call
    if (isSmokeDemo() && me && smokeSide && smokeSide !== "a") {
      const inv = smokeInvite ?? readSmokeInvite();
      out.push({
        id: "smoke-accept",
        at: Number.MAX_SAFE_INTEGER,
        tone: "accept",
        title: inv ? `Invitation: join ${inv.eventId}` : "Invitation: join the US · China · Russia case",
        detail: inv ? `${inv.pair} · Accept to enter the room and call` : "American Satellite Dynamics opened coordination · Accept to enter",
        eventId: inv?.eventId ?? "CE-SMOKE1",
      });
    }
    const ROOM = ["communication", "proposal", "approved", "scheduled", "awaiting_verification", "verified", "monitoring", "needs_decision"];
    for (const e of events) {
      // a case keeps its notices once its channel existed (a plan was published), even while agents re-plan
      if (!e.parties?.some((p) => p.role === "b") || (!ROOM.includes(e.status) && !e.proposals?.length)) continue;
      const pair = `${e.a.name} × ${e.b.name}`;
      if (humans.some((h) => h.eventId === e.id && h.side === viewer)) out.push({ id: `due-${e.id}`, at: Number.MAX_SAFE_INTEGER - 1, tone: "due", title: `Your decision is needed on ${e.id}`, detail: pair, eventId: e.id });
      const others = (e.parties ?? []).filter((p) => p.role !== viewer).map((p) => p.operator.replace(/\s*\(synthetic\)/i, ""));
      out.push({ id: `room-${e.id}`, at: e.createdAt, tone: "info", title: `You were added to the coordination for ${e.id}`, detail: `${pair} · with ${others.join(", ")}`, eventId: e.id });
      if (resolved?.eventId === e.id) out.push({ id: `ok-${e.id}`, at: resolved.at, tone: "ok", title: `${e.id} resolved`, detail: pair, eventId: e.id });
    }
    return out.sort((a, b) => (a.tone === "accept" || a.tone === "due" ? -1 : b.tone === "accept" || b.tone === "due" ? 1 : b.at - a.at)).slice(0, 6);
  }, [events, humans, viewer, resolved, me, smokeInvite]);
  if (items.length === 0) return null;
  const COLOR = { due: "var(--orange)", info: "#9cc2ff", ok: "var(--green)", accept: "var(--green)" } as const;
  return (
    <section className="mb-3 px-2 pt-1">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">Notifications</div>
      <ul className="space-y-1.5">
        {items.map((n) => (
          <li key={n.id} className="flex items-center gap-3 rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR[n.tone], boxShadow: n.tone === "due" || n.tone === "accept" ? `0 0 10px ${COLOR[n.tone]}` : undefined }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-white">{n.title}</div>
              <div className="truncate text-[12px] text-neutral-500">{n.detail}</div>
            </div>
            <button
              className={`btn h-8 shrink-0 px-3 text-[12px] ${n.tone === "due" || n.tone === "accept" ? "btn-primary" : "text-neutral-300"}`}
              onClick={() => {
                sfx.whoosh();
                if (n.tone === "accept" && me?.userId) {
                  acceptSmokeInvite(me.userId);
                  return;
                }
                useOps.getState().set({ tab: "decision", incident: n.eventId, focusEvent: n.eventId, incidentView: "expanded" });
              }}
            >
              {n.tone === "accept" ? "Accept" : "Open"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AuditBody({ companyName }: { companyName: string }) {
  const dev = useOps((s) => s.dev);
  const events = useOps((s) => s.events);
  const replies = useOps((s) => s.replies);
  const [eventId, setEventId] = useState("");
  const [pages, setPages] = useState(1);
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => {
    // The default six-month window uses the clock, which is only known on the client.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- avoids a server/client date mismatch
    setPeriod(defaultPeriod());
  }, []);

  const rows = useMemo(() => (dev ? auditEntries(events, replies) : []), [dev, events, replies]);
  const filtered = eventId ? rows.filter((r) => r.eventId === eventId) : rows;
  const shown = filtered.slice(0, pages * PAGE);
  const cases = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) if (!seen.has(row.eventId)) seen.set(row.eventId, row.eventLabel);
    return [...seen.entries()];
  }, [rows]);

  const bounds = period ? periodBounds(period.start, period.end) : null;
  const simulatedInPeriod = bounds
    ? events.filter((e) => (e.a.synthetic || e.b.synthetic || !!e.scenario) && e.createdAt >= bounds.from && e.createdAt <= bounds.to).length
    : 0;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-h-0 flex-col border-r border-white/[0.06]">
        <header className="flex items-end justify-between gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[16px] font-semibold text-white">Inbox</h1>
              {dev && !isSmokeDemo() && rows.length > 0 && <Chip color="var(--orange)" size="sm">Synthetic</Chip>}
            </div>
            <p className="mt-1 text-[12.5px] text-neutral-500">{companyName} · notifications and the shared record, newest first</p>
          </div>
          <div className="shrink-0">
            <Select
              size="md"
              label="Case"
              value={eventId}
              onChange={(id) => {
                setEventId(id);
                setPages(1);
              }}
              options={[{ value: "", label: "All cases" }, ...cases.map(([id, label]) => ({ value: id, label }))]}
              width={300}
              maxTriggerWidth={240}
            />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {(dev || isSmokeDemo()) && <Notices />}
          {!dev && !isSmokeDemo() ? (
            <Empty
              title="No shared log on this deployment yet"
              body="When a case is recorded, each message, selection, approval, veto, schedule result and verification is listed here. Policy numbers stay out of it."
            />
          ) : shown.length === 0 ? (
            <Empty
              title="No cases on this screen yet"
              body="Run a scan on Orbit and run the agents on a case. What was shared (the plan, the answers, the result) is listed here. Policy numbers are not."
            />
          ) : (
            <ul className="space-y-1.5">
              {shown.map((row) => (
                <Entry key={row.id} row={row} />
              ))}
            </ul>
          )}
          {filtered.length > shown.length && (
            <button
              className="btn mt-2 h-8 w-full text-[12px]"
              onClick={() => {
                sfx.click();
                setPages((n) => n + 1);
              }}
            >
              Older entries
            </button>
          )}
        </div>
      </div>
      <Report companyName={companyName} period={period} setPeriod={setPeriod} dev={dev} simulatedInPeriod={simulatedInPeriod} rangeOk={!!bounds} />
    </div>
  );
}

function Entry({ row }: { row: AuditEntry }) {
  const meta = AUDIT_ACTION[row.action];
  const t = fmtUtc(row.at);
  return (
    <li className="rounded-[12px] bg-white/[0.025] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <div className="flex items-center gap-2">
        <span className="mono tnum text-[11px] text-neutral-500">
          {t.date} {t.time}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-300">{row.actor}</span>
        <Chip color={meta.color} size="sm">{meta.label}</Chip>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[1.45] text-white">{row.summary}</p>
      {(row.before || row.after) && (
        <p className="mono mt-1 text-[11px] text-neutral-500">
          {row.before ?? "—"}
          <span className="px-1 text-faint">→</span>
          {row.after ?? "—"}
        </p>
      )}
      <button
        className="mt-1 max-w-full truncate text-left text-[11.5px] text-neutral-500 underline-offset-2 hover:text-white hover:underline"
        onClick={() => {
          sfx.click();
          useOps.getState().set({ tab: "decision", incident: row.eventId, focusEvent: row.eventId, incidentView: "expanded" });
        }}
      >
        {row.eventLabel}
      </button>
    </li>
  );
}

function Report({
  companyName,
  period,
  setPeriod,
  dev,
  simulatedInPeriod,
  rangeOk,
}: {
  companyName: string;
  period: { start: string; end: string } | null;
  setPeriod: (p: { start: string; end: string }) => void;
  dev: boolean;
  simulatedInPeriod: number;
  rangeOk: boolean;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto px-4 py-4">
      <div className="eyebrow">Report draft</div>
      <h2 className="mt-1 text-[13.5px] font-semibold text-white">{companyName}</h2>
      <p className="mt-1 text-[12px] leading-[1.5] text-neutral-500">Your company only. Six months is the default period. Simulated cases are excluded, and policy values are not exported.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10.5px] text-muted">From, UTC</span>
          <input
            type="date"
            className={`${input} w-full`}
            value={period?.start ?? ""}
            onChange={(e) => period && setPeriod({ ...period, start: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10.5px] text-muted">To, UTC</span>
          <input
            type="date"
            className={`${input} w-full`}
            value={period?.end ?? ""}
            onChange={(e) => period && setPeriod({ ...period, end: e.target.value })}
          />
        </label>
      </div>
      {!rangeOk && period && <p className="mt-2 text-[11.5px] text-red">The period has to be a real UTC range.</p>}
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Stat label="Unique cases" />
        <Stat label="With coordination" />
        <Stat label="Scheduled" />
        <Stat label="Observed execution" />
        <Stat label="Unresolved" />
        <Stat label="FCC fields" value="To verify" />
      </dl>
      <p className="mt-3 text-[12px] leading-[1.5] text-neutral-500">
        Counts stay blank until the report query is on this deployment. Filling them with zero would claim a measurement this screen does not have.
      </p>
      {dev && simulatedInPeriod > 0 && (
        <p className="mt-2 text-[12px] leading-[1.5] text-orange">
          {simulatedInPeriod} simulated {simulatedInPeriod === 1 ? "case" : "cases"} in this period {simulatedInPeriod === 1 ? "is" : "are"} on screen and {simulatedInPeriod === 1 ? "is" : "are"} left out of the draft.
        </p>
      )}
      <div className="mt-4 space-y-2 border-t border-white/[0.06] pt-3">
        <div className="text-[12px] font-medium text-neutral-300">Not in this draft</div>
        <Missing field="Source coverage" note="Not measured on this screen." />
        <Missing field="Observed execution" note="Promised and observed stay separate. Approval is not execution." />
        <Missing field="FCC mapping" note="Fields outside OrbitCall are marked to verify. Nothing here is a filing." />
      </div>
      <button className="btn mt-4 h-8 w-full gap-1.5 text-[12px] opacity-50" disabled>
        <Download size={13} /> Download CSV
      </button>
      <p className="mt-2 text-[11.5px] leading-[1.45] text-neutral-500">CSV export arrives with the report action. It leaves out policy values and simulated cases. Review the draft before anyone uses it for a report.</p>
    </aside>
  );
}

function Stat({ label, value = "—" }: { label: string; value?: string }) {
  return (
    <div className="rounded-[10px] bg-white/[0.03] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd className="mono tnum mt-0.5 text-[14px] text-white">{value}</dd>
    </div>
  );
}

function Missing({ field, note }: { field: string; note: string }) {
  return (
    <div>
      <div className="text-[12px] text-neutral-300">{field}</div>
      <div className="text-[11.5px] leading-[1.45] text-neutral-500">{note}</div>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-3 py-10 text-center">
      <div className="text-[14px] font-semibold text-white">{title}</div>
      <p className="mx-auto mt-2 max-w-[380px] text-[12.5px] leading-[1.55] text-neutral-500">{body}</p>
    </div>
  );
}
