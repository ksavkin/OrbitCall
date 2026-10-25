"use client";

import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { DEMO_ACCOUNTS, useSession } from "./session";

// Sign in. Auth0 is the provider (spec §1); until its tenant is configured the button explains that, and the
// demo accounts sign in locally with simulated fleets. Sign-up is open: a new account has no scan access
// until the team sets it up, and its profile says how to ask.

const AUTH0_READY = !!process.env.NEXT_PUBLIC_AUTH0_DOMAIN && !!process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID;

export function SignInScreen() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const pick = (id: string) => {
    sfx.chime();
    signIn(id);
    router.push("/");
  };
  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-black px-4 py-10 text-neutral-200">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-[440px]">
        <Link href="/" className="mb-8 inline-flex items-center gap-1.5 text-[12.5px] text-neutral-500 hover:text-neutral-300">
          <ArrowLeft size={13} /> Back to the globe
        </Link>
        <div className="text-[26px] font-semibold tracking-[-0.02em] text-white">Sign in to OrbitCall</div>
        <p className="mt-2 text-[14px] leading-[1.6] text-neutral-400">Dispatchers see their own fleet, scan it for close approaches and coordinate with the other operator.</p>

        <div className="mt-7 space-y-2">
          <button className="btn btn-primary h-11 w-full gap-2 text-[14px] disabled:opacity-40" disabled={!AUTH0_READY}>
            <Lock size={14} /> Continue with Auth0
          </button>
          <button className="btn h-11 w-full text-[14px] text-neutral-300 disabled:opacity-40" disabled={!AUTH0_READY}>
            Create an account
          </button>
          {!AUTH0_READY && <div className="pt-1 text-[12px] text-neutral-500">Auth0 is not configured on this deployment yet. Use a demo account below.</div>}
        </div>

        <div className="mt-8 border-t border-white/[0.07] pt-6">
          <div className="text-[13px] font-semibold text-neutral-300">Demo accounts</div>
          <div className="mt-0.5 text-[12px] text-neutral-500">Simulated companies and fleets, for testing and the demo.</div>
          <div className="mt-3 overflow-hidden rounded-[14px] shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            {DEMO_ACCOUNTS.map(({ me, fleet }, i) => (
              <button
                key={me.userId}
                onClick={() => pick(me.userId)}
                onPointerEnter={() => sfx.hover()}
                className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04] ${i ? "border-t border-white/[0.06]" : ""}`}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.16)]">
                  <Flag code={me.company?.country ?? me.dispatcherCountry} h={32} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-white">{me.company?.name ?? "New account, no access yet"}</span>
                  <span className="block truncate text-[12px] text-neutral-500">
                    {me.name} · {me.access === "granted" ? `${fleet.length} satellites` : "can browse, cannot scan"}
                  </span>
                </span>
                <ArrowRight size={14} className="text-neutral-600 transition-colors group-hover:text-white" />
              </button>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
