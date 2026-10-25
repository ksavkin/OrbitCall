"use client";

import { motion } from "motion/react";
import { ArrowLeft, Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sfx } from "@/lib/sound";
import { useAuth0 } from "@auth0/auth0-react";
import { AUTH0_ENABLED } from "@/lib/backend/provider";
import { useSession } from "./session";

// Sign in. Auth0 is the provider (spec §1); until its tenant is configured the Auth0 button explains that, and
// team accounts sign in with a username and password checked on the server. No account is listed here:
// knowing the login is what lets someone in.


export function SignInScreen() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    const err = await signIn(username, password);
    setBusy(false);
    if (err) {
      sfx.click();
      setError(err);
      return;
    }
    sfx.chime();
    router.push("/");
  };

  const field =
    "h-11 w-full rounded-[10px] bg-white/[0.05] px-3.5 text-[14px] text-white outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] placeholder:text-neutral-600 focus:bg-white/[0.07] focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]";

  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-black px-4 py-10 text-neutral-200">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-[400px]">
        <Link href="/" className="mb-8 inline-flex items-center gap-1.5 text-[12.5px] text-neutral-500 hover:text-neutral-300">
          <ArrowLeft size={13} /> Back to the globe
        </Link>
        <div className="text-[26px] font-semibold tracking-[-0.02em] text-white">Sign in to OrbitCall</div>
        <p className="mt-2 text-[14px] leading-[1.6] text-neutral-400">Dispatchers see their own fleet, scan it for close approaches and coordinate with the other operator.</p>

        <form className="mt-7 space-y-2.5" onSubmit={submit}>
          <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} />
          <input className={field} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" autoComplete="current-password" />
          {error && (
            <div className="text-[13px] text-[#ff8a80]" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary h-11 w-full gap-2 text-[14px] disabled:opacity-40" disabled={busy || !username.trim() || !password}>
            {busy && <Loader2 size={14} className="animate-spin" />} Sign in
          </button>
        </form>

        <div className="mt-6 border-t border-white/[0.07] pt-5">{AUTH0_ENABLED ? <Auth0Buttons /> : <Auth0Off />}</div>
      </motion.div>
    </div>
  );
}

/** Auth0 sign-in and sign-up. Only rendered under Auth0Provider. A new account has no access until the team
 * provisions it; its profile shows how to ask. */
function Auth0Buttons() {
  const { loginWithRedirect, isLoading } = useAuth0();
  return (
    <div className="space-y-2">
      <button
        className="btn h-11 w-full gap-2 text-[14px] text-white disabled:opacity-40"
        disabled={isLoading}
        onClick={() => {
          sfx.click();
          void loginWithRedirect();
        }}
      >
        <Lock size={14} /> Continue with Auth0
      </button>
      <button
        className="h-9 w-full text-[13px] text-neutral-400 hover:text-white disabled:opacity-40"
        disabled={isLoading}
        onClick={() => {
          sfx.click();
          void loginWithRedirect({ authorizationParams: { screen_hint: "signup" } });
        }}
      >
        Create an account
      </button>
    </div>
  );
}

function Auth0Off() {
  return (
    <>
      <button className="btn h-11 w-full gap-2 text-[14px] text-neutral-300 disabled:opacity-40" disabled>
        <Lock size={14} /> Continue with Auth0
      </button>
      <div className="pt-2 text-[12px] text-neutral-500">Auth0 sign-in and sign-up open once the tenant is configured.</div>
    </>
  );
}
