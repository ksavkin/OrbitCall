"use client";

import { DoorOpen, ServerOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoordinationCall } from "@/call/useCoordinationCall";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import { fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import type { RoomCard } from "@/components/roomChat/model";
import { toggleDev } from "@/components/ui/Navbar";
import { CallStage, type FlagOf, type StageCall, type StageMode } from "./CallStage";

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
  const [mode, setMode] = useState<StageMode>("voice");
  // typing never talks: Space-to-talk is on only in Voice mode
  const call = useCoordinationCall({ roomId: target.roomId, devToken: target.devToken, spaceToTalk: mode === "voice" });
  return (
    <CallStage call={call} mode={mode} onMode={setMode} flagOf={flagOfLang} title={`Coordination room · ${target.roomId}`} subtitle="Live call · translated by the voice worker" />
  );
}

// Test identities carry a language, not a country. The demo's three dispatchers are US, Russia and China, so the
// flag follows the language for display only; a flag never grants access.
const FLAG_BY_LANG: Record<string, string> = { en: "us", ru: "ru", zh: "cn" };
const flagOfLang: FlagOf = (p) => (p.lang ? (FLAG_BY_LANG[p.lang] ?? null) : null);

/* ---------------------------------------------------------------- the call of a case */

/** The plan a phrase names: "option B" / "plan 2" / "P2" / "вариант Б" → "P2". Null when it names none. */
function planNamed(text: string): string | null {
  const t = text.toLowerCase();
  const m = t.match(/\b(?:option|plan|card)\s*([a-d1-4])\b/) ?? t.match(/\bp\s*([1-4])\b/) ?? t.match(/вариант\s*([а-г1-4])/);
  if (!m) return null;
  const k = m[1];
  const n = "abcd".indexOf(k) + 1 || "абвг".indexOf(k) + 1 || Number(k);
  return n >= 1 && n <= 4 ? `P${n}` : null;
}

/**
 * One case's call on the stage, whichever call drives it (dev: the simulated call in RoomsScreen). It joins on its
 * own when asked, tells the parties bar who is in the call and speaking, and offers a plan named by voice to the plan
 * panel, which asks for a click to confirm it (speech never approves).
 */
export function CaseCallStage({
  e,
  call,
  compact,
  mode,
  onMode,
  lockedBy,
  cards,
  autoJoin,
}: {
  e: ConjunctionEvent;
  call: StageCall;
  compact: boolean;
  mode: StageMode;
  onMode: (m: StageMode) => void;
  lockedBy?: string;
  cards?: RoomCard[];
  autoJoin: boolean;
}) {
  // in a running case the call joins on its own: nobody should hunt for Join in the middle of a decision
  const joinedOnce = useRef(false);
  useEffect(() => {
    if (!autoJoin || joinedOnce.current || call.state !== "idle") return;
    joinedOnce.current = true;
    void call.join();
  }, [autoJoin, call]);

  // the parties bar shows who is in the call and who is speaking; only the case's docked call reports it
  const inCallKey = call.participants.filter((p) => !p.isTranslator).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const speakingKey = call.participants.filter((p) => p.speaking).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const me = call.identity?.replace(/^user-/, "") ?? null;
  useEffect(() => {
    if (!compact) return;
    useOps.setState({ callLive: { eventId: e.id, inCall: inCallKey ? inCallKey.split(",") : [], speaking: speakingKey ? speakingKey.split(",") : [], messages: call.captions ?? [], me } });
  }, [compact, e.id, inCallKey, speakingKey, call.captions, me]);
  useEffect(() => (compact ? () => useOps.setState({ callLive: null }) : undefined), [compact]);

  // "option B", "P2", "вариант Б": a plan named in the call is offered for confirmation in the plan panel
  const lastSaid = useRef<string | null>(null);
  useEffect(() => {
    const myId = call.identity?.replace(/^user-/, "");
    const mine = [...(call.captions ?? [])].reverse().find((m) => m.author.kind === "human" && m.author.userId === myId);
    if (!mine || mine.messageId === lastSaid.current) return;
    lastSaid.current = mine.messageId;
    const label = planNamed(mine.originalText);
    if (label) useOps.setState({ voiceIntent: { eventId: e.id, label, said: mine.originalText, at: Date.now() } });
  }, [call.captions, call.identity, e.id]);

  const flagOf: FlagOf = (p) => {
    if (p.isTranslator) return null;
    const id = p.identity.replace(/^user-/, "");
    return e.parties?.find((x) => x.id === id)?.country ?? null;
  };
  return (
    <CallStage
      compact={compact}
      lockedBy={lockedBy}
      call={call}
      mode={mode}
      onMode={onMode}
      cards={cards}
      flagOf={flagOf}
      title={`Coordination room · ${e.id}`}
      subtitle={
        <>
          {e.a.name} × {e.b.name} · closest approach {fmtWhen(e.tca)}
        </>
      }
    />
  );
}

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
