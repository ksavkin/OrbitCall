"use client";

import { DoorOpen, ServerOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useCoordinationCall } from "@/call/useCoordinationCall";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import { sfx } from "@/lib/sound";
import { toggleDev } from "@/components/ui/Navbar";
import { CallStage, type FlagOf } from "./CallStage";

// Live mode: the real call. Rooms are not linked to cases in the backend yet (the call module keeps roomId as a
// string until the team's rooms table exists), and until sign-in exists each person joins with a dev token from
// `npx convex run call/demo:seed`. So a room opens from ?room=…&token=… in the URL, or from the form below.

export type LiveTarget = { roomId: string; devToken?: string };

const KEY = "orbit.room";

function fromUrl(): LiveTarget | null {
  const q = new URLSearchParams(window.location.search);
  const roomId = q.get("room");
  return roomId ? { roomId, devToken: q.get("token") ?? undefined } : null;
}

/** The room this tab is in: the URL wins, then what was entered earlier in this tab. */
export function useLiveTarget() {
  const [target, setTarget] = useState<LiveTarget | null>(null);
  useEffect(() => {
    let t = fromUrl();
    if (!t) {
      try {
        const raw = sessionStorage.getItem(KEY);
        if (raw) t = JSON.parse(raw) as LiveTarget;
      } catch {
        /* storage blocked */
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window and storage exist only after mount
    if (t) setTarget(t);
  }, []);
  const set = (t: LiveTarget | null) => {
    try {
      if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage blocked */
    }
    setTarget(t);
  };
  return [target, set] as const;
}

export function LiveRoom({ target, onLeave, onOpen }: { target: LiveTarget | null; onLeave: () => void; onOpen: (t: LiveTarget) => void }) {
  if (!CONVEX_ENABLED) return <NoBackend />;
  if (!target) return <JoinForm onOpen={onOpen} />;
  return (
    <QueryBoundary
      key={`${target.roomId}:${target.devToken ?? ""}`}
      fallback={(e) => (
        <Center
          icon={<ServerOff size={18} />}
          title="Could not open this room"
          body={`${briefError(e)}. Check the room ID and the token, and that the call functions are deployed.`}
          action={
            <button className="btn btn-ghost-line mt-4 h-9 px-3 text-[12.5px]" onClick={onLeave}>
              Use another room
            </button>
          }
        />
      )}
    >
      <Call target={target} />
    </QueryBoundary>
  );
}

function Call({ target }: { target: LiveTarget }) {
  const call = useCoordinationCall({ roomId: target.roomId, devToken: target.devToken });
  return <CallStage call={call} flagOf={flagOfLang} title={`Coordination room · ${target.roomId}`} subtitle="Live call · translated by the voice worker" />;
}

// Test identities carry a language, not a country. The demo's three dispatchers are US, Russia and China, so the
// flag follows the language for display only; a flag never grants access.
const FLAG_BY_LANG: Record<string, string> = { en: "us", ru: "ru", zh: "cn" };
const flagOfLang: FlagOf = (p) => (p.lang ? (FLAG_BY_LANG[p.lang] ?? null) : null);

function JoinForm({ onOpen }: { onOpen: (t: LiveTarget) => void }) {
  const [roomId, setRoomId] = useState("");
  const [token, setToken] = useState("");
  return (
    <Center
      icon={<DoorOpen size={18} />}
      title="Open a room"
      body="Rooms are not linked to cases yet. Paste the room ID and your token from the seed command. The token stays in this tab only."
      action={
        <form
          className="mx-auto mt-5 grid w-full max-w-[360px] gap-2 text-left"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!roomId.trim()) return;
            sfx.click();
            onOpen({ roomId: roomId.trim(), devToken: token.trim() || undefined });
          }}
        >
          <input
            value={roomId}
            onChange={(ev) => setRoomId(ev.target.value)}
            placeholder="Room ID, like demo-1a2b3c"
            className="h-10 rounded-[10px] bg-white/[0.05] px-3 text-[13.5px] text-white outline-none placeholder:text-neutral-600 focus:bg-white/[0.08]"
          />
          <input
            value={token}
            onChange={(ev) => setToken(ev.target.value)}
            type="password"
            autoComplete="off"
            placeholder="Dev token"
            className="h-10 rounded-[10px] bg-white/[0.05] px-3 text-[13.5px] text-white outline-none placeholder:text-neutral-600 focus:bg-white/[0.08]"
          />
          <button className="btn btn-primary mt-1 h-10 text-[13px]" disabled={!roomId.trim()}>
            Open room
          </button>
        </form>
      }
    />
  );
}

function NoBackend() {
  return (
    <Center
      icon={<ServerOff size={18} />}
      title="Live rooms need the backend"
      body="This app is not connected to Convex. Set NEXT_PUBLIC_CONVEX_URL in web/.env.local to the deployment that has the call functions, and run the voice worker."
      action={
        <button className="btn btn-ghost-line mt-4 h-9 px-3 text-[12.5px]" onClick={() => toggleDev()}>
          Try a simulated room <span className="kbd">D</span>
        </button>
      }
    />
  );
}

function Center({ title, body, icon, action }: { title: string; body: string; icon?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-10 text-center">
      <div className="w-full max-w-[440px]">
        {icon && <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-white/[0.05] text-neutral-400">{icon}</div>}
        <div className="text-[16px] font-semibold text-white">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.6] text-neutral-500">{body}</p>
        {action}
      </div>
    </div>
  );
}
