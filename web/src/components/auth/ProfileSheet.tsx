"use client";

import { AnimatePresence, motion } from "motion/react";
import { Lock, Mail, X } from "lucide-react";
import { Flag } from "@/components/ui/OwnerBadge";
import { ACCESS_EMAIL, useFleet, useMe, useSession, type FleetSatellite, type Me } from "./session";

// The signed-in person's profile: company, role, language, and the assigned fleet (spec §3.2 FLEET-1..4).
// An account without access sees how to ask for it instead of a fleet.

const LANG = { en: "English", ru: "Russian", zh: "Mandarin" } as const;

export function ProfileSheet() {
  const open = useSession((s) => s.profileOpen);
  const setOpen = useSession((s) => s.setProfileOpen);
  const me = useMe();
  const fleet = useFleet();
  return (
    <AnimatePresence>
      {open && me && (
        <motion.div
          key="profile"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-auto absolute inset-0 z-[55] grid place-items-center bg-black/50 backdrop-blur-[3px]"
          onPointerDown={(ev) => ev.target === ev.currentTarget && setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="w-[640px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] bg-[rgba(8,8,10,0.97)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_40px_100px_-30px_rgba(0,0,0,0.9)]"
            role="dialog"
            aria-label="Profile"
          >
            <Header me={me} onClose={() => setOpen(false)} />
            {me.access === "granted" ? <Fleet fleet={fleet} /> : <RequestAccess me={me} />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({ me, onClose }: { me: Me; onClose: () => void }) {
  return (
    <div className="flex items-start gap-4 border-b border-white/[0.06] px-6 py-5">
      <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.16)]">
        <Flag code={me.company?.country ?? me.dispatcherCountry} h={44} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[18px] font-semibold tracking-[-0.01em] text-white">{me.name}</div>
        <div className="text-[13px] text-neutral-500">{me.email}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-neutral-400">
          {me.company && <span>{me.company.name}</span>}
          <span>{me.role === "operator" ? "Dispatcher" : me.role === "head_of_ops" ? "Head of operations" : "Observer"}</span>
          <span>Speaks {LANG[me.language]}</span>
          {me.company?.simulated && <span className="text-orange">Demo account · simulated fleet</span>}
        </div>
      </div>
      <button className="icon-btn -mr-2 h-8 w-8" onClick={onClose} aria-label="Close">
        <X size={15} />
      </button>
    </div>
  );
}

function Fleet({ fleet }: { fleet: FleetSatellite[] }) {
  return (
    <div className="px-6 py-5">
      <div className="flex items-baseline justify-between">
        <div className="text-[14px] font-semibold text-white">My fleet</div>
        <div className="text-[12px] text-neutral-500">{fleet.length} satellites assigned to you · Run scan checks all of them</div>
      </div>
      <div className="mt-3 overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
        {fleet.map((f, i) => (
          <div key={f.object.objectId} className={`flex items-center gap-4 px-4 py-3 ${i ? "border-t border-white/[0.06]" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-white">{f.object.name}</div>
              <div className="mono mt-0.5 text-[11.5px] text-neutral-500">
                NORAD {f.object.norad} · {f.object.orbit}
              </div>
            </div>
            <span className={`text-[12px] ${f.freshness === "current" ? "text-neutral-400" : "text-amber"}`}>{f.freshness === "current" ? "Orbit data current" : f.freshness === "stale" ? "Orbit data stale" : "Orbit data unknown"}</span>
            <span className={`w-[96px] text-right text-[12.5px] font-medium ${f.unresolvedIncidentCount ? "text-[#ff8a80]" : "text-neutral-500"}`}>
              {f.unresolvedIncidentCount ? `${f.unresolvedIncidentCount} open case${f.unresolvedIncidentCount > 1 ? "s" : ""}` : "No open cases"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestAccess({ me }: { me: Me }) {
  const subject = encodeURIComponent("OrbitCall access request");
  const body = encodeURIComponent(`Hello,\n\nI would like access to OrbitCall.\n\nAccount: ${me.email}\nCompany:\nSatellites I operate (NORAD IDs):\n\nThank you.`);
  return (
    <div className="px-6 py-6">
      <div className="flex items-start gap-3 rounded-[14px] bg-white/[0.03] p-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-neutral-400">
          <Lock size={14} />
        </span>
        <div>
          <div className="text-[14.5px] font-semibold text-white">Your account has no scan access yet</div>
          <p className="mt-1 text-[13px] leading-[1.6] text-neutral-400">
            You can browse the live catalog and the globe. Scans, cases and coordination rooms run paid analysis, so they open only for accounts the team has
            set up with a company and its satellites. Write to us and we will set it up.
          </p>
          <a className="btn btn-primary mt-4 inline-flex h-9 gap-1.5 px-4 text-[13px]" href={`mailto:${ACCESS_EMAIL}?subject=${subject}&body=${body}`}>
            <Mail size={13} /> Request access
          </a>
          <div className="mt-2 text-[12px] text-neutral-500">{ACCESS_EMAIL}</div>
        </div>
      </div>
    </div>
  );
}
