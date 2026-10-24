"use client";

import { Building2 } from "lucide-react";
import type { OwnerInfo } from "@/lib/owners";

export function Flag({ code, h = 11 }: { code: string; h?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/flags/${code}.svg`}
      alt=""
      width={Math.round((h * 4) / 3)}
      height={h}
      className="shrink-0 rounded-[2px] object-cover shadow-[0_0_0_0.5px_rgba(255,255,255,0.25)]"
      style={{ width: Math.round((h * 4) / 3), height: h }}
      draggable={false}
    />
  );
}

/** Flag(s) + short owner name; organizations get a neutral badge instead of a flag. */
export function OwnerBadge({ owner, h = 11, className = "" }: { owner: OwnerInfo; h?: number; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={owner.fullName}>
      {owner.isOrg ? (
        <span
          className="grid shrink-0 place-items-center rounded-[2px] bg-white/10 text-muted"
          style={{ width: Math.round((h * 4) / 3), height: h }}
        >
          <Building2 size={h - 3} strokeWidth={2} />
        </span>
      ) : (
        <span className="flex shrink-0 gap-0.5">
          {owner.flags.map((f) => (
            <Flag key={f} code={f} h={h} />
          ))}
        </span>
      )}
      <span className="truncate">{owner.name}</span>
    </span>
  );
}
