"use client";

import { motion } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useFleet, useMe, useSession, type FleetSatellite, type Me } from "@/components/auth/session";
import { Chip } from "@/components/ui/Chip";
import { ScreenFrame, ScreenMessage } from "@/components/ui/ScreenFrame";
import { policyMineRef, policyUpdateRef, settingsMineRef, settingsUpdateRef } from "@/lib/backend/api";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import { CONVEX_AUTH, CONVEX_ENABLED } from "@/lib/backend/provider";
import { fmtUtc } from "@/lib/format";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";
import {
  checkPolicy,
  convexMessage,
  fingerprint,
  hydrate,
  issueAt,
  loadPolicy,
  newWindow,
  policyPayload,
  savePolicy,
  serverToDraft,
  toUtc,
  type PolicyDraft,
  type PolicyIssue,
  type Priority,
  type SatelliteDraft,
  type WindowDraft,
} from "./model";

const LANGS = [
  { id: "en" as const, label: "English" },
  { id: "ru" as const, label: "Russian" },
  { id: "zh" as const, label: "Mandarin" },
];

const PRIORITY: Priority[] = ["low", "normal", "high"];

const input =
  "h-8 w-full min-w-0 rounded-[8px] bg-white/[0.045] px-2.5 text-[12px] text-white outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] placeholder:text-neutral-600 focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]";

// Policy is one page: private per-satellite limits, and shareable contact/language kept in a separate card (POL-1, POL-4).

export function PolicyScreen() {
  const userId = useSession((s) => s.userId);
  const me = useMe();
  const fleet = useFleet();

  return (
    <ScreenFrame label="Policy">
      {userId === undefined ? (
        <ScreenMessage title="Checking sign-in" body="Policy is private to your company. Confirming who is signed in." />
      ) : !me ? (
        <ScreenMessage
          title="Sign in to edit policy"
          body="Fuel reserves, mission windows and acceptable risk stay inside your company. Sign in as an operator to edit them."
          action={<SignInLink />}
        />
      ) : me.role === "head_of_ops" ? (
        <ScreenMessage
          title="Operators edit policy"
          body="Heads of operations read the audit log. The numbers in a policy stay with the company's operators and their advocate."
          action={<AuditButton />}
        />
      ) : me.role !== "operator" || !me.company || me.access !== "granted" ? (
        <ScreenMessage title="No company policy" body="This account has no company fleet, so there is no policy to edit." action={<SignInLink label="Use another account" />} />
      ) : (
        <PolicyBody me={me} fleet={fleet} />
      )}
    </ScreenFrame>
  );
}

function PolicyBody({ me, fleet }: { me: Me; fleet: FleetSatellite[] }) {
  const company = me.company!;
  const dev = useOps((st) => st.dev);
  // The live policy needs a signed-in identity Convex knows: an Auth0 login whose account session.me returned.
  // A demo login exists only in this website, so asking the server for its policy would be refused (and threw).
  const serverAccount = useSession((st) => st.backend?.status === "ok");
  if (!dev && CONVEX_ENABLED && CONVEX_AUTH && serverAccount) {
    return (
      <QueryBoundary fallback={(e) => <ScreenMessage title="Policy is unavailable" body={briefError(e)} />}>
        <PolicyLive fleet={fleet} companyName={company.name} simulated={company.simulated} />
      </QueryBoundary>
    );
  }
  return <LocalPolicy companyId={company.companyId} companyName={company.name} fleet={fleet} />;
}

function LocalPolicy({ companyId, companyName, fleet }: { companyId: string; companyName: string; fleet: FleetSatellite[] }) {
  const fleetKey = fleet.map((f) => f.object.objectId).join("|");
  const [initial, setInitial] = useState<{ draft: PolicyDraft; savedAt: string | null } | null>(null);
  useEffect(() => {
    const stored = loadPolicy(companyId);
    // localStorage exists only after mount; fleet is the list that matches fleetKey
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saved policy is browser storage, not render state
    setInitial({ draft: hydrate(stored?.draft ?? null, fleet, companyId), savedAt: stored?.draft.savedAt ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new fleet array with the same ids must not reset the form
  }, [companyId, fleetKey]);

  if (!initial) return <ScreenMessage title="Loading policy" body="Reading the copy saved in this browser." />;
  return (
    <PolicyForm
      key={companyId}
      initial={initial.draft}
      savedAt={initial.savedAt}
      mode="local"
      simulated
      companyName={companyName}
      onSave={async (draft) => {
        const at = savePolicy(companyId, draft);
        return { savedAt: at, message: "Saved in this browser. This copy is synthetic, so the agents do not see it and no case is re-run." };
      }}
    />
  );
}

function PolicyLive({ fleet, companyName, simulated }: { fleet: FleetSatellite[]; companyName: string; simulated: boolean }) {
  const policy = useQuery(policyMineRef, {});
  const settings = useQuery(settingsMineRef, {});
  const update = useMutation(policyUpdateRef);
  const updateSettings = useMutation(settingsUpdateRef);
  if (policy === undefined || settings === undefined) return <ScreenMessage title="Loading policy" body="Reading your company's policy." />;
  const initial = serverToDraft(policy.satellites, settings, fleet);
  return (
    <PolicyForm
      initial={initial}
      savedAt={policy.updatedAt}
      mode="live"
      simulated={simulated || policy.simulated}
      companyName={companyName}
      revision={policy.revision}
      onSave={async (draft) => {
        await update({ satellites: policyPayload(draft) });
        await updateSettings({ ...(draft.language ? { language: draft.language } : {}), contact: draft.contact.trim() });
        return { savedAt: new Date().toISOString(), message: "Saved. Open cases are negotiated again. A scheduled maneuver is marked for review and is not replaced." };
      }}
    />
  );
}

function PolicyForm({
  initial,
  savedAt,
  mode,
  simulated,
  companyName,
  revision,
  onSave,
}: {
  initial: PolicyDraft;
  savedAt: string | null;
  mode: "local" | "live";
  simulated: boolean;
  companyName: string;
  revision?: number;
  onSave: (draft: PolicyDraft) => Promise<{ savedAt: string; message: string }>;
}) {
  const [draft, setDraft] = useState(initial);
  const [savedMark, setSavedMark] = useState(fingerprint(initial));
  const [savedAtText, setSavedAtText] = useState(savedAt);
  const [issues, setIssues] = useState<PolicyIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = fingerprint(draft) !== savedMark;
  const formError = issueAt(issues, "", "form");

  const save = async () => {
    const next = canonicalize(draft);
    const found = checkPolicy(next, mode);
    setDraft(next);
    setIssues(found);
    setMessage(null);
    setError(null);
    if (found.length) {
      sfx.click();
      return;
    }
    setBusy(true);
    try {
      const result = await onSave(next);
      setSavedMark(fingerprint(next));
      setSavedAtText(result.savedAt);
      setMessage(result.message);
      sfx.click();
    } catch (e) {
      setError(convexMessage(e));
      sfx.click();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[16px] font-semibold text-white">Policy</h1>
            {simulated && <Chip color="var(--orange)" size="sm">Synthetic</Chip>}
            {revision ? <span className="mono text-[11px] text-neutral-500">rev {revision}</span> : null}
          </div>
          <p className="mt-1 text-[12.5px] text-neutral-500">Private to {companyName}. The other operator never sees these numbers.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedAtText && <span className="mono text-[11px] text-neutral-500">Saved {fmtUtc(Date.parse(savedAtText)).time} UTC</span>}
          <button className="btn btn-primary h-8 px-3 text-[12.5px] disabled:opacity-40" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving" : "Save policy"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-[840px] flex-col gap-3">
          <p className="rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[1.55] text-neutral-400">
            A change is shared only as a category: fuel, mission window, risk, or priority. Hard windows block a burn. Preferred windows can be traded. Saving on the backend re-runs open cases and flags a scheduled maneuver for review. It does not rewrite the schedule.
          </p>
          {(formError || error) && <p className="text-[12.5px] text-red">{formError || error}</p>}
          {message && <p className="text-[12.5px] text-green">{message}</p>}

          <section className="rounded-[14px] bg-white/[0.025] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
            <div className="eyebrow">Shared with the other operator</div>
            <h2 className="mt-1 text-[13.5px] font-semibold text-white">Contact and language</h2>
            <p className="mt-1 text-[12px] leading-[1.5] text-neutral-500">Kept apart from the policy. This is how the other company can reach you.</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {LANGS.map((lang) => (
                <button
                  key={lang.id}
                  className="btn relative h-7 px-2.5"
                  data-active={draft.language === lang.id}
                  onClick={() => {
                    sfx.click();
                    setDraft((d) => ({ ...d, language: lang.id }));
                  }}
                >
                  {draft.language === lang.id && <motion.span layoutId="policy-lang" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  <span className="relative">{lang.label}</span>
                </button>
              ))}
            </div>
            <label className="mt-3 block">
              <span className="mb-1 block text-[10.5px] text-muted">Contact</span>
              <input
                className={`${input} ${issueAt(issues, "", "contact") ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}
                value={draft.contact}
                placeholder="Email, phone, or how to reach the desk"
                maxLength={200}
                onChange={(e) => setDraft((d) => ({ ...d, contact: e.target.value }))}
              />
              {issueAt(issues, "", "contact") && <span className="mt-1 block text-[11px] text-red">{issueAt(issues, "", "contact")}</span>}
            </label>
          </section>

          {draft.satellites.length === 0 ? (
            <p className="rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[12.5px] text-neutral-500">No satellites are assigned to you yet. Contact and language above can still be saved.</p>
          ) : (
            draft.satellites.map((sat) => (
              <SatelliteCard
                key={sat.objectId}
                sat={sat}
                issues={issues}
                onChange={(patch) => setDraft((d) => ({ ...d, satellites: d.satellites.map((s) => (s.objectId === sat.objectId ? { ...s, ...patch } : s)) }))}
                onWindows={(field, windows) => setDraft((d) => ({ ...d, satellites: d.satellites.map((s) => (s.objectId === sat.objectId ? { ...s, [field]: windows } : s)) }))}
              />
            ))
          )}
          <p className="pb-2 text-[12px] text-neutral-500">A blank satellite card is left unset. Fill the numbers only for the spacecraft you want a policy on.</p>
        </div>
      </div>
    </div>
  );
}

function SatelliteCard({
  sat,
  issues,
  onChange,
  onWindows,
}: {
  sat: SatelliteDraft;
  issues: PolicyIssue[];
  onChange: (patch: Partial<SatelliteDraft>) => void;
  onWindows: (field: "protectedWindows" | "preferredWindows", windows: WindowDraft[]) => void;
}) {
  const err = (field: string) => issueAt(issues, sat.objectId, field);
  return (
    <section className="rounded-[14px] bg-white/[0.025] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">Private</div>
          <h2 className="mt-1 truncate text-[13.5px] font-semibold text-white">{sat.name}</h2>
        </div>
        <div className="mono shrink-0 text-[11px] text-neutral-500">
          {sat.norad !== null ? `NORAD ${sat.norad}` : sat.objectId}
          {sat.orbit ? ` · ${sat.orbit}` : ""}
        </div>
      </div>
      {err("objectId") && <p className="mt-2 text-[12px] text-red">{err("objectId")}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Num label="Minimum fuel reserve" unit="kg" value={sat.minFuelReserveKg} error={err("minFuelReserveKg")} onChange={(minFuelReserveKg) => onChange({ minFuelReserveKg })} />
        <Num label="Current fuel" unit="kg" value={sat.currentFuelKg} error={err("currentFuelKg")} onChange={(currentFuelKg) => onChange({ currentFuelKg })} />
        <Num label="Dry mass" unit="kg" value={sat.dryMassKg} error={err("dryMassKg")} onChange={(dryMassKg) => onChange({ dryMassKg })} />
        <Num label="Specific impulse" unit="s" value={sat.ispS} error={err("ispS")} onChange={(ispS) => onChange({ ispS })} />
        <Num label="Acceptable probability" unit="0 to 1" value={sat.acceptablePc} error={err("acceptablePc")} placeholder="1e-4" onChange={(acceptablePc) => onChange({ acceptablePc })} />
        <div className="block">
          <span className="mb-1 block text-[10.5px] text-muted">Mission priority</span>
          <span className="flex h-8 rounded-[8px] bg-white/[0.04] p-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            {PRIORITY.map((p) => (
              <button
                key={p}
                type="button"
                className="btn relative h-7 flex-1 capitalize"
                aria-label={p}
                data-active={sat.missionPriority === p}
                onClick={() => {
                  sfx.click();
                  onChange({ missionPriority: p });
                }}
              >
                {sat.missionPriority === p && (
                  <motion.span layoutId={`pri-${sat.objectId}`} className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                )}
                <span className="relative">{p}</span>
              </button>
            ))}
          </span>
        </div>
      </div>
      <Windows
        title="Protected windows"
        hint="Hard constraint. A proposal must stay outside these."
        rows={sat.protectedWindows}
        field="protectedWindows"
        issues={issues}
        objectId={sat.objectId}
        onChange={(windows) => onWindows("protectedWindows", windows)}
      />
      <Windows
        title="Preferred windows"
        hint="Preference. The agents can trade these off."
        rows={sat.preferredWindows}
        field="preferredWindows"
        issues={issues}
        objectId={sat.objectId}
        onChange={(windows) => onWindows("preferredWindows", windows)}
      />
    </section>
  );
}

function Num({ label, unit, value, error, placeholder, onChange }: { label: string; unit: string; value: string; error?: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[10.5px] text-muted">
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-faint">{unit}</span>
      </span>
      <input
        className={`${input} mono tnum ${error ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}
        value={value}
        inputMode="decimal"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className="mt-1 block text-[11px] text-red">{error}</span>}
    </label>
  );
}

function Windows({
  title,
  hint,
  rows,
  field,
  issues,
  objectId,
  onChange,
}: {
  title: string;
  hint: string;
  rows: WindowDraft[];
  field: "protectedWindows" | "preferredWindows";
  issues: PolicyIssue[];
  objectId: string;
  onChange: (rows: WindowDraft[]) => void;
}) {
  const tooMany = issueAt(issues, objectId, field);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[12.5px] font-medium text-white">{title}</div>
          <div className="text-[11.5px] text-neutral-500">{hint}</div>
        </div>
        <button
          type="button"
          className="btn h-7 gap-1 px-2 text-[12px]"
          onClick={() => {
            sfx.click();
            onChange([...rows, newWindow()]);
          }}
        >
          <Plus size={12} /> Add
        </button>
      </div>
      {tooMany && <p className="mt-1 text-[11px] text-red">{tooMany}</p>}
      <div className="mt-2 space-y-1.5">
        {rows.map((row, i) => {
          const startError = issueAt(issues, objectId, `${field}.${i}.startUtc`);
          const endError = issueAt(issues, objectId, `${field}.${i}.endUtc`);
          const reasonError = issueAt(issues, objectId, `${field}.${i}.reason`);
          const rowError = startError || endError || reasonError;
          return (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_28px] gap-1.5">
              <Utc value={row.startUtc} error={startError} onChange={(startUtc) => onChange(rows.map((r) => (r.key === row.key ? { ...r, startUtc } : r)))} />
              <Utc value={row.endUtc} error={endError} onChange={(endUtc) => onChange(rows.map((r) => (r.key === row.key ? { ...r, endUtc } : r)))} />
              <input
                className={`${input} ${reasonError ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}
                value={row.reason}
                placeholder="Reason"
                maxLength={500}
                aria-label={`${title} reason`}
                aria-invalid={!!reasonError}
                onChange={(e) => onChange(rows.map((r) => (r.key === row.key ? { ...r, reason: e.target.value } : r)))}
              />
              <button
                type="button"
                className="icon-btn h-8 w-7"
                aria-label={`Remove ${title.toLowerCase()}`}
                onClick={() => {
                  sfx.click();
                  onChange(rows.filter((r) => r.key !== row.key));
                }}
              >
                <X size={13} />
              </button>
              {rowError && <p className="col-span-4 text-[11px] text-red">{[startError, endError, reasonError].filter((m, n, all) => m && all.indexOf(m) === n).join(" ")}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Utc({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
  return (
    <input
      className={`${input} mono ${error ? "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]" : ""}`}
      value={value}
      placeholder="2026-10-24T21:00:00Z"
      spellCheck={false}
      autoComplete="off"
      aria-label="UTC time"
      aria-invalid={!!error}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function canonicalize(draft: PolicyDraft): PolicyDraft {
  const windows = (rows: WindowDraft[]) => rows.map((w) => ({ ...w, startUtc: toUtc(w.startUtc) ?? w.startUtc.trim(), endUtc: toUtc(w.endUtc) ?? w.endUtc.trim(), reason: w.reason.trim() }));
  return {
    language: draft.language,
    contact: draft.contact.trim(),
    satellites: draft.satellites.map((s) => ({ ...s, protectedWindows: windows(s.protectedWindows), preferredWindows: windows(s.preferredWindows) })),
  };
}

function SignInLink({ label = "Sign in" }: { label?: string }) {
  return (
    <Link href="/signin" className="btn btn-primary h-9 px-3 text-[13px]" onClick={() => sfx.click()}>
      {label}
    </Link>
  );
}

function AuditButton() {
  return (
    <button
      className="btn btn-primary h-9 px-3 text-[13px]"
      onClick={() => {
        sfx.click();
        useOps.getState().set({ tab: "audit" });
      }}
    >
      Open the audit log
    </button>
  );
}
