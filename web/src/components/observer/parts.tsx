"use client";

import { Check, Eye } from "lucide-react";
import type { ReactNode } from "react";
import { fmtCountdown, fmtWhen } from "@/lib/ops/format";
import { STEPS } from "@/components/ops/IncidentView";
import { RoomTimeline } from "@/components/roomChat/RoomTimeline";
import type { RoomCard } from "@/components/roomChat/model";

// The large display's frame and pieces, shared by the dev feed (ObserverScreen) and the backend view (LiveObserver).

/** Case names on the left, the countdown and the connection on the right. */
export function TopBar({ head, tca, now, link }: { head?: ReactNode; tca?: number | null; now: number; link: { text: string; on: boolean } }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-white/[0.06] px-6 py-4">
      <div className="text-[17px] font-semibold tracking-[-0.01em] text-white">OrbitCall</div>
      <span className="flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[12px] text-neutral-400">
        <Eye size={12} /> Public view · read only
      </span>
      {head}
      <div className="ml-auto flex items-center gap-5">
        {tca != null && now > 0 && (
          <div className="text-right">
            <div className="tnum text-[26px] font-semibold leading-none tracking-[-0.02em] text-white">{fmtCountdown(tca - now).replace("T−", "")}</div>
            <div className="mt-1 text-[11.5px] text-neutral-500">until closest approach · {fmtWhen(tca)}</div>
          </div>
        )}
        <span className={`flex items-center gap-1.5 text-[12px] ${link.on ? "text-green" : "text-neutral-500"}`}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: link.on ? "var(--green)" : "#525252" }} />
          {link.text}
        </span>
      </div>
    </div>
  );
}

/** The case's progress through STEPS; `at` past the last step marks every step done. */
export function Stepper({ at }: { at: number }) {
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

/** The shared decisions of the case's room. */
export function RoomRecord({ cards, empty }: { cards: RoomCard[]; empty: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pb-2 pt-5">
        <div className="text-[15px] font-semibold text-white">Room record</div>
        <div className="text-[12px] text-neutral-500">Shared decisions only. What people say stays in the room.</div>
      </div>
      <RoomTimeline messages={[]} cards={cards} myUserId={null} empty={empty} testId="observer-record" />
    </div>
  );
}

// Provenance stays in the data; the public view does not badge it.
export function SimTag() {
  return null;
}

export function Big({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[12px] text-neutral-500">{label}</div>
      <div className="tnum mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em]" style={{ color: tone ?? "#fff" }}>
        {value}
      </div>
    </div>
  );
}

export function Note({ title, body, icon, action }: { title: string; body?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-[460px] py-16 text-center">
      {icon && <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-white/[0.05] text-neutral-400">{icon}</div>}
      <div className="text-[17px] font-semibold text-white">{title}</div>
      {body && <p className="mt-2 text-[13.5px] leading-[1.6] text-neutral-500">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
