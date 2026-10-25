"use client";

import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, ChevronUp, Crosshair, Loader2, Rocket, RotateCcw, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { useSession } from "@/components/auth/session";
import { Tooltip } from "@/components/ui/Tooltip";
import { demoResetRef, launchDefaultsRef, launchSatelliteRef } from "@/lib/backend/api";
import { backendError, type BackendError } from "@/lib/backend/errors";
import { openCase, useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { act, mutate } from "@/lib/backend/run";
import type { DemoRunId, EventId, LaunchDefaults, LaunchInput, ObjectId } from "@/lib/backend/types";
import { runAgentsOn } from "@/lib/backend/workflow";
import { fmtOdds } from "@/lib/ops/format";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { useNow } from "@/lib/useNow";

// Real-mode counterpart of the dev ScenarioBar (wiring map §10): launch a simulated satellite onto a close approach
// with a registered one, then open its case or run agents on it; reset closes the demo run. The server checks every
// field again (convex/demoLaunch.ts reserve); the checks here only spare a round trip.

const EASE = [0.22, 1, 0.36, 1] as const;
const HOUR = 3600_000;
/** The server accepts a closest approach up to 72 h ahead (demoLaunch.ts:54). */
const WINDOW = 72 * HOUR;
/** From this many assigned satellites on, the server asks which one the launch replaces (demoLaunch.ts:65). */
const SLOTS = 4;

type Draft = { name: string; ownerName: string; ownerCountry: string; targetObjectId: string; tcaUtc: string; scenarioPc: string; replaceObjectId: string };
type Issues = Partial<Record<keyof Draft, string>>;
type Launched = { objectId: ObjectId; eventId: EventId; targetObjectId: ObjectId };
type Panel = "launch" | "reset";

/** Shown when config.flags.demoLaunch is on and the signed-in account is an operator; any refusal of launchDefaults hides it. */
export function DemoControls() {
  const on = useLive((s) => s.flags?.demoLaunch === true);
  const me = useSession((s) => (s.backend?.status === "ok" ? s.backend.me : null));
  if (!on || me?.role !== "operator") return null;
  return (
    <QueryBoundary key={me.userId}>
      <Controls assigned={me.assignedObjectIds} />
    </QueryBoundary>
  );
}

function Controls({ assigned }: { assigned: string[] }) {
  const defaults = useQuery(launchDefaultsRef, {});
  const [panel, setPanel] = useState<Panel | null>(null);
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [launching, setLaunching] = useState(false);
  const [failure, setFailure] = useState<BackendError | null>(null);
  const [launched, setLaunched] = useState<Launched | null>(null);
  // The run the last launch went into; reset closes that one, or the caller's latest open run when unknown.
  const [runId, setRunId] = useState<DemoRunId | null>(null);

  useEffect(() => {
    if (!panel) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [panel]);

  if (defaults === undefined) return null;

  const toggle = (p: Panel) => {
    sfx.click();
    // launchDefaults suggests its time when the query last ran, which can be long enough ago to leave the window
    const now = Date.now();
    const tca = parseUtc(defaults.tcaUtc);
    if (p === "launch" && edits.tcaUtc === undefined && (tca === null || tca < now + HOUR || tca > now + WINDOW)) {
      setEdits((e) => ({ ...e, tcaUtc: isoUtc(Math.floor(now / 1000) * 1000 + 24 * HOUR) }));
    }
    setPanel((cur) => (cur === p ? null : p));
  };

  const edit = (patch: Partial<Draft>) => {
    setEdits((e) => ({ ...e, ...patch }));
    setFailure(null);
  };

  const launch = async (input: LaunchInput) => {
    sfx.whoosh();
    setLaunching(true);
    setFailure(null);
    try {
      // a fresh request ID per launch: the server refuses to reuse one whose launch failed (IN_PROGRESS)
      const r = await act(launchSatelliteRef, { ...input, requestId: crypto.randomUUID() });
      setLaunched({ objectId: r.objectId, eventId: r.eventId, targetObjectId: input.targetObjectId });
      setRunId(r.demoRunId);
      setEdits({});
    } catch (e) {
      setFailure(readError(e));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="pointer-events-auto absolute bottom-[48px] left-1/2 z-30 -translate-x-1/2"
    >
      <AnimatePresence mode="wait">
        {panel && (
          <motion.div
            key={panel}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.2, ease: EASE }}
            role="dialog"
            aria-label={panel === "reset" ? "Reset the demonstration" : "Launch a demo satellite"}
            className="glass glass-strong absolute bottom-[calc(100%+8px)] left-1/2 w-[356px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[13px] p-3"
          >
            {panel === "reset" ? (
              <ResetPanel
                runId={runId}
                onClose={() => setPanel(null)}
                onReset={() => {
                  setLaunched(null);
                  setRunId(null);
                }}
              />
            ) : launched ? (
              <LaunchedView
                launched={launched}
                onClose={() => setPanel(null)}
                onAgain={() => setLaunched(null)}
                onStarted={() => {
                  setLaunched(null);
                  setPanel(null);
                }}
              />
            ) : (
              <LaunchForm
                draft={{ ...fromDefaults(defaults), ...edits }}
                assigned={assigned}
                busy={launching}
                failure={failure}
                onEdit={edit}
                onLaunch={launch}
                onClose={() => setPanel(null)}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="glass relative flex h-10 items-center gap-1 rounded-[13px] px-1">
        <span className="mono ml-1.5 mr-1 rounded-[4px] px-1 py-px text-[9px] font-medium uppercase tracking-[0.12em] text-orange shadow-[inset_0_0_0_1px_rgba(255,159,64,0.28)]">
          Demo
        </span>
        <button className="btn h-7 gap-1.5 px-2 text-[11.5px]" onClick={() => toggle("launch")} aria-expanded={panel === "launch"}>
          <Rocket size={12} className="text-muted" />
          Launch satellite
          <ChevronUp size={12} className={`shrink-0 text-muted transition-transform duration-200 ${panel === "launch" ? "" : "rotate-180"}`} />
        </button>
        <AnimatePresence>
          {(launching || launched || (failure && panel !== "launch")) && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              className="flex items-center overflow-hidden whitespace-nowrap px-1.5 text-[10.5px]"
            >
              {launching ? (
                <span className="flex items-center gap-1.5 text-blue">
                  <span className="pulse-dot" style={{ width: 5, height: 5 }} /> Launching
                </span>
              ) : launched ? (
                <span className="flex items-center gap-1 text-green">
                  <Check size={11} /> <span className="mono">{launched.objectId}</span>
                </span>
              ) : (
                <span className="text-red">Launch failed</span>
              )}
            </motion.span>
          )}
        </AnimatePresence>
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <Tooltip label={launching ? "Wait for the launch to finish" : "Reset the demonstration"}>
          <button
            className="icon-btn h-7 w-7"
            data-active={panel === "reset"}
            disabled={launching}
            onClick={() => toggle("reset")}
            aria-expanded={panel === "reset"}
            aria-label="Reset the demonstration"
          >
            <RotateCcw size={12} />
          </button>
        </Tooltip>
      </div>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- launch */

function LaunchForm({
  draft,
  assigned,
  busy,
  failure,
  onEdit,
  onLaunch,
  onClose,
}: {
  draft: Draft;
  assigned: string[];
  busy: boolean;
  failure: BackendError | null;
  onEdit: (patch: Partial<Draft>) => void;
  onLaunch: (input: LaunchInput) => void;
  onClose: () => void;
}) {
  const now = useNow(30_000);
  const [tried, setTried] = useState(false);
  const issues: Issues = tried && now > 0 ? validate(draft, assigned.length, now).issues : {};
  const target = useCatalogName(draft.targetObjectId.trim());
  const selected = useOrbit((s) => s.selected);
  const selectedName = useCatalogName(selected === null ? "" : String(selected));
  const tca = parseUtc(draft.tcaUtc);
  const pc = parsePc(draft.scenarioPc);
  // the server's NOT_FOUND belongs to the target field; every other refusal reads as a line above the button
  const targetError = issues.targetObjectId ?? (failure?.code === "NOT_FOUND" ? failure.message : undefined);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    const { input } = validate(draft, assigned.length, Date.now());
    if (input) onLaunch(input);
  };

  return (
    <motion.form initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }} onSubmit={submit} noValidate>
      <Header title="Launch a demo satellite" onClose={onClose} />
      <p className="mt-1 text-[11px] leading-[1.5] text-muted">
        Places a simulated satellite on a close approach with a registered one. The satellite and its encounter are marked simulated.
      </p>
      <div className="mt-3 grid gap-2.5">
        <Field label="Name" value={draft.name} error={issues.name} maxLength={80} disabled={busy} onChange={(e) => onEdit({ name: e.target.value })} />
        <div className="grid grid-cols-[1fr_76px] gap-2">
          <Field label="Owner" value={draft.ownerName} error={issues.ownerName} maxLength={80} disabled={busy} onChange={(e) => onEdit({ ownerName: e.target.value })} />
          <Field label="Country" value={draft.ownerCountry} error={issues.ownerCountry} maxLength={80} disabled={busy} onChange={(e) => onEdit({ ownerCountry: e.target.value })} />
        </div>
        <div className="min-w-0">
          <Field
            label="Target"
            aside={target}
            mono
            inputMode="numeric"
            placeholder="NORAD ID"
            value={draft.targetObjectId}
            error={targetError}
            disabled={busy}
            onChange={(e) => onEdit({ targetObjectId: e.target.value })}
          />
          {selected !== null && String(selected) !== draft.targetObjectId.trim() && (
            <button
              type="button"
              className="btn mt-1 h-6 max-w-full gap-1.5 px-1.5 text-[10.5px] text-muted"
              disabled={busy}
              onClick={() => {
                sfx.select();
                onEdit({ targetObjectId: String(selected) });
              }}
            >
              <Crosshair size={11} className="shrink-0" />
              <span className="truncate">Use selected{selectedName ? ` · ${selectedName}` : ""}</span>
            </button>
          )}
        </div>
        <div className="grid grid-cols-[1fr_112px] gap-2">
          <Field
            label="Closest approach, UTC"
            aside={now > 0 && tca !== null && tca > now ? fmtIn(tca - now) : null}
            mono
            value={draft.tcaUtc}
            error={issues.tcaUtc}
            disabled={busy}
            onChange={(e) => onEdit({ tcaUtc: e.target.value })}
          />
          <Field
            label="Chance"
            aside={pc !== null && pc > 0 ? fmtOdds(pc) : null}
            mono
            inputMode="decimal"
            value={draft.scenarioPc}
            error={issues.scenarioPc}
            disabled={busy}
            onChange={(e) => onEdit({ scenarioPc: e.target.value })}
          />
        </div>
        {assigned.length >= SLOTS && (
          <Slots assigned={assigned} value={draft.replaceObjectId} error={issues.replaceObjectId} disabled={busy} onPick={(id) => onEdit({ replaceObjectId: id })} />
        )}
      </div>
      {failure && failure.code !== "NOT_FOUND" && <Alert>{failure.message}</Alert>}
      <button type="submit" className="btn btn-primary mt-3 h-8 w-full gap-1.5 text-[12px]" disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={12} />}
        {busy ? "Launching…" : "Launch"}
      </button>
    </motion.form>
  );
}

/** Which assigned satellite the new one replaces, once the fleet holds its four demo slots. */
function Slots({ assigned, value, error, disabled, onPick }: { assigned: string[]; value: string; error?: string; disabled: boolean; onPick: (id: string) => void }) {
  const fleet = useLive((s) => s.fleet);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10.5px] text-muted">Replaces</div>
      <div className={`flex flex-wrap items-center gap-0.5 rounded-[9px] bg-white/[0.03] p-0.5 ${error ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}>
        {assigned.map((id) => {
          const name = fleet?.satellites.find((s) => s.object.objectId === id)?.object.name;
          const chip = (
            <button
              type="button"
              className="btn relative h-6 px-1.5 text-[10.5px]"
              data-active={value === id}
              disabled={disabled}
              onClick={() => {
                sfx.click();
                onPick(id);
              }}
            >
              {value === id && <motion.span layoutId="demo-slot" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="mono relative">{id}</span>
            </button>
          );
          return name && name !== id ? (
            <Tooltip key={id} label={name}>
              {chip}
            </Tooltip>
          ) : (
            <Fragment key={id}>{chip}</Fragment>
          );
        })}
      </div>
      {error && <span className="mt-1 block text-[11px] text-red">{error}</span>}
    </div>
  );
}

function LaunchedView({ launched, onClose, onAgain, onStarted }: { launched: Launched; onClose: () => void; onAgain: () => void; onStarted: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useCatalogName(launched.targetObjectId);

  const runAgents = async () => {
    sfx.whoosh();
    setStarting(true);
    setError(null);
    try {
      const failed = await runAgentsOn(launched.eventId);
      if (failed) setError(failed.message);
      else onStarted();
    } catch (e) {
      setError(readError(e).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}>
      <Header title="Demo satellite launched" onClose={onClose} />
      <p className="mt-1.5 text-[12px] leading-[1.5] text-fg-2">
        <span className="mono text-fg">{launched.objectId}</span> has a simulated close approach with{" "}
        <span className="mono text-fg">{launched.targetObjectId}</span>
        {target ? ` ${target}` : ""}. A case for the encounter was created.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          className="btn btn-primary h-8 flex-1 gap-1.5 text-[12px]"
          disabled={starting}
          onClick={() => {
            sfx.whoosh();
            openCase(launched.eventId);
          }}
        >
          Open case <ArrowRight size={12} />
        </button>
        <button className="btn btn-ghost-line h-8 flex-1 gap-1.5 text-[12px]" disabled={starting} onClick={runAgents}>
          {starting && <Loader2 size={13} className="animate-spin" />}
          {starting ? "Starting…" : "Run agents"}
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      <button
        className="btn mt-2 h-6 px-1.5 text-[10.5px] text-muted"
        disabled={starting}
        onClick={() => {
          sfx.click();
          onAgain();
        }}
      >
        Launch another
      </button>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- reset */

/** demoReset.reset behind an explicit confirm: it closes the run for everyone in it. */
function ResetPanel({ runId, onClose, onReset }: { runId: DemoRunId | null; onClose: () => void; onReset: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<{ runId: DemoRunId | null } | null>(null);

  const reset = async () => {
    sfx.click();
    setBusy(true);
    setError(null);
    try {
      const r = await mutate(demoResetRef, runId ? { demoRunId: runId } : {});
      setClosed({ runId: r.closedRunId });
      onReset();
    } catch (e) {
      setError(readError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (closed)
    return (
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}>
        <Header title="Demonstration reset" onClose={onClose} />
        <p className="mt-1.5 text-[12px] leading-[1.5] text-fg-2">
          {closed.runId ? (
            <>
              Closed run <span className="mono break-all text-fg">{closed.runId}</span>.
            </>
          ) : (
            "You have no open demo run to close."
          )}
        </p>
        <button className="btn btn-ghost-line mt-3 h-8 w-full text-[12px]" onClick={onClose}>
          Done
        </button>
      </motion.div>
    );

  return (
    <div>
      <Header title="Reset the demonstration" onClose={onClose} />
      <p className="mt-1.5 text-[12px] leading-[1.5] text-fg-2">
        Closes your demo run. Its cases and rooms close, running agents stop, and the demo satellites leave your fleet.
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-ghost-line h-8 flex-1 text-[12px]" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn h-8 flex-1 gap-1.5 bg-[rgba(255,90,79,0.12)] text-[12px] text-[#ff8a80] shadow-[inset_0_0_0_1px_rgba(255,90,79,0.35)] hover:bg-[rgba(255,90,79,0.2)] hover:text-[#ffa39b]"
          disabled={busy}
          onClick={reset}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={12} />}
          {busy ? "Closing…" : "Close run"}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- parts */

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="eyebrow">{title}</div>
      <button type="button" className="icon-btn -mr-1 -mt-1 h-6 w-6" onClick={onClose} aria-label="Close">
        <X size={12} />
      </button>
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2.5 rounded-[6px] bg-[rgba(255,90,79,0.08)] px-2 py-1 text-[11.5px] leading-[1.45] text-red" role="alert">
      {children}
    </div>
  );
}

const input =
  "h-8 w-full min-w-0 rounded-[8px] bg-white/[0.045] px-2.5 text-[12px] text-white outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] placeholder:text-neutral-600 focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)] disabled:opacity-60";

function Field({ label, aside, error, mono, ...props }: { label: string; aside?: ReactNode; error?: string; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[10.5px] text-muted">
        <span className="shrink-0">{label}</span>
        {aside && <span className="mono min-w-0 truncate text-faint">{aside}</span>}
      </span>
      <input
        className={`${input} ${mono ? "mono tnum" : ""} ${error ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error}
        {...props}
      />
      {error && <span className="mt-1 block text-[11px] text-red">{error}</span>}
    </label>
  );
}

/** The globe catalog's name for a NORAD ID, as a label only: the server decides what counts as registered. */
function useCatalogName(id: string): string | null {
  const catalog = useOrbit((s) => s.catalog);
  return useMemo(() => {
    if (!/^\d{1,9}$/.test(id) || !catalog) return null;
    const norad = Number(id);
    return catalog.objects.find((o) => o.norad === norad)?.name ?? null;
  }, [catalog, id]);
}

/* ---------------------------------------------------------------- input rules */

function fromDefaults(d: LaunchDefaults): Draft {
  return {
    name: d.name,
    ownerName: d.ownerName,
    ownerCountry: d.ownerCountry,
    targetObjectId: d.targetObjectId ?? "",
    tcaUtc: d.tcaUtc,
    scenarioPc: String(d.scenarioPc),
    replaceObjectId: "",
  };
}

/** The server's rules (demoLaunch.ts:51-65); `input` is set only when nothing is wrong. */
function validate(d: Draft, slots: number, now: number): { issues: Issues; input: LaunchInput | null } {
  const issues: Issues = {};
  for (const k of ["name", "ownerName", "ownerCountry"] as const) {
    const text = d[k].trim();
    if (!text || text.length > 80) issues[k] = "Use 1 to 80 characters.";
  }
  const target = d.targetObjectId.trim();
  if (!/^\d{1,9}$/.test(target)) issues.targetObjectId = "Use the target's NORAD catalog number.";
  const tca = parseUtc(d.tcaUtc);
  if (tca === null) issues.tcaUtc = "Use a UTC time ending in Z.";
  else if (tca <= now || tca > now + WINDOW) issues.tcaUtc = "Choose a time within the next 72 hours.";
  const pc = parsePc(d.scenarioPc);
  if (pc === null) issues.scenarioPc = "Between 0 and 1.";
  if (slots >= SLOTS && !d.replaceObjectId) issues.replaceObjectId = "Choose the assigned satellite this one replaces.";
  if (Object.keys(issues).length > 0 || tca === null || pc === null) return { issues, input: null };
  return {
    issues,
    input: {
      name: d.name.trim(),
      ownerName: d.ownerName.trim(),
      ownerCountry: d.ownerCountry.trim(),
      targetObjectId: target,
      tcaUtc: isoUtc(tca),
      scenarioPc: pc,
      ...(d.replaceObjectId ? { replaceObjectId: d.replaceObjectId } : {}),
    },
  };
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

function parseUtc(text: string): number | null {
  const t = text.trim();
  if (!UTC.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function parsePc(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const pc = Number(t);
  return Number.isFinite(pc) && pc >= 0 && pc <= 1 ? pc : null;
}

/** The server compares the time with its own ISO form, which drops ".000" (convex/lib/events.ts isoUtc). */
function isoUtc(ms: number) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** "in 23 h 05 m": the window is at most 72 h, so hours are enough. */
function fmtIn(ms: number) {
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60_000);
  return `in ${h} h ${String(m).padStart(2, "0")} m`;
}

/** A backend refusal as written for users; anything else as its first line. */
function readError(e: unknown): BackendError {
  const err = backendError(e);
  return err.code === "UNKNOWN" ? { code: err.code, message: briefError(e instanceof Error ? e : new Error(String(e))) } : err;
}
