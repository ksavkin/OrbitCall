"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, LogIn, LogOut, Satellite, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { CONVEX_AUTH, CONVEX_ENABLED } from "@/lib/backend/provider";
import { BackendSession } from "./BackendSession";
import { restoreSession, useMe, useSession } from "./session";

// Top right: who is signed in, with their company's flag. The menu opens the profile and fleet, or signs out.

export function AccountMenu() {
  return (
    <>
      {CONVEX_ENABLED && CONVEX_AUTH && <BackendSession />}
      <AccountButton />
    </>
  );
}

function AccountButton() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const setProfileOpen = useSession((s) => s.setProfileOpen);
  const signOut = useSession((s) => s.signOut);

  useEffect(() => void restoreSession(), []);
  useEffect(() => {
    if (!open) return;
    const close = (ev: PointerEvent) => !box.current?.contains(ev.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const known = useSession((s) => s.userId !== undefined);
  if (!known) return <span className="h-7 w-[92px]" />;
  if (!me)
    return (
      <Link href="/signin" className="btn h-7 gap-1.5 px-2.5 text-[12px] text-white" onClick={() => sfx.click()}>
        <LogIn size={13} /> Sign in
      </Link>
    );

  return (
    <div ref={box} className="relative">
      <button
        className="flex h-7 items-center gap-2 rounded-[9px] pl-1 pr-1.5 text-left transition-colors hover:bg-white/[0.06]"
        onClick={() => {
          sfx.click();
          setOpen((o) => !o);
        }}
        aria-label="Account"
        aria-expanded={open}
      >
        <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.18)]">
          {me.company?.country ? <Flag code={me.company.country} h={20} /> : <UserRound size={12} className="text-neutral-400" />}
        </span>
        <span className="max-w-[150px] truncate text-[11.5px] text-fg-2">{me.company?.name ?? me.name}</span>
        <ChevronDown size={12} className="text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="glass glass-strong absolute right-0 top-9 z-50 w-[260px] overflow-hidden rounded-[14px] p-1.5"
          >
            <div className="px-2.5 pb-2.5 pt-2">
              <div className="text-[13px] font-semibold text-white">{me.name ?? "Name not set"}</div>
              <div className="truncate text-[11.5px] text-neutral-500">{me.email}</div>
              <div className={`mt-1.5 text-[11.5px] ${me.access === "granted" ? "text-green" : "text-orange"}`}>
                {me.access === "granted" ? `Dispatcher · ${me.company?.name}` : "No scan access yet"}
              </div>
            </div>
            <div className="h-px bg-white/[0.07]" />
            <MenuItem
              icon={me.access === "granted" ? <Satellite size={13} /> : <UserRound size={13} />}
              label={me.access === "granted" ? "Profile and fleet" : "Profile and access"}
              onClick={() => {
                setOpen(false);
                setProfileOpen(true);
              }}
            />
            <MenuItem
              icon={<LogOut size={13} />}
              label="Sign out"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[12.5px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white"
      onClick={() => {
        sfx.click();
        onClick?.();
      }}
    >
      <span className="text-neutral-500">{icon}</span>
      {label}
    </button>
  );
}
