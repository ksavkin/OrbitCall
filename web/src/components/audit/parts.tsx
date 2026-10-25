import type { ReactNode } from "react";

// Pieces both the simulator view (AuditScreen) and the backend view (LiveAudit) draw with.

export function Stat({ label, value = "—", loading = false }: { label: string; value?: string; loading?: boolean }) {
  return (
    <div className="rounded-[10px] bg-white/[0.03] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd className="mono tnum mt-0.5 text-[14px] text-white">
        {loading ? <span className="inline-block h-2.5 w-7 animate-pulse rounded bg-white/[0.07] align-middle" /> : value}
      </dd>
    </div>
  );
}

export function Missing({ field, note }: { field: string; note: string }) {
  return (
    <div>
      <div className="text-[12px] text-neutral-300">{field}</div>
      <div className="text-[11.5px] leading-[1.45] text-neutral-500">{note}</div>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-3 py-10 text-center">
      <div className="text-[14px] font-semibold text-white">{title}</div>
      <p className="mx-auto mt-2 max-w-[380px] text-[12.5px] leading-[1.55] text-neutral-500">{body}</p>
      {action}
    </div>
  );
}
