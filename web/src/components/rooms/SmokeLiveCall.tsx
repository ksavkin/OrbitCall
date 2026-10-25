"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useCoordinationCall } from "@/call/useCoordinationCall";
import { useMe } from "@/components/auth/session";
import { smokeCallEnsureRef } from "@/lib/backend/api";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { fmtWhen } from "@/lib/ops/format";
import { CallStage, type FlagOf, type StageMode } from "./CallStage";

type Who = "en" | "ru" | "zh";

function whoFor(userId: string | undefined): Who {
  if (userId === "demo-ru") return "ru";
  if (userId === "demo-cn") return "zh";
  return "en";
}

const FLAG_BY_LANG: Record<string, string> = { en: "us", ru: "ru", zh: "cn" };

/**
 * Real LiveKit call for the smoke recording: one shared room, translator worker, Space only in Voice mode.
 */
export function SmokeLiveCall({
  e,
  compact = false,
  lockedBy,
}: {
  e: ConjunctionEvent;
  compact?: boolean;
  lockedBy?: string;
}) {
  if (!CONVEX_ENABLED) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-neutral-500">
        Convex is not configured (NEXT_PUBLIC_CONVEX_URL). LiveKit needs the backend.
      </div>
    );
  }
  return (
    <QueryBoundary
      fallback={(err) => (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div className="text-[14px] font-medium text-white">Could not open the call</div>
          <p className="mt-2 max-w-sm text-[12.5px] text-neutral-500">{briefError(err)}</p>
          <p className="mt-2 max-w-sm text-[11px] text-neutral-600">Check the connection and try Join again.</p>
        </div>
      )}
    >
      <SmokeLiveCallInner e={e} compact={compact} lockedBy={lockedBy} />
    </QueryBoundary>
  );
}

function SmokeLiveCallInner({ e, compact, lockedBy }: { e: ConjunctionEvent; compact?: boolean; lockedBy?: string }) {
  const me = useMe();
  const who = whoFor(me?.userId);
  const ensure = useMutation(smokeCallEnsureRef);
  const [target, setTarget] = useState<{ roomId: string; devToken: string } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await ensure({ who });
        if (!cancelled) setTarget({ roomId: r.roomId, devToken: r.devToken });
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensure, who]);

  if (bootError) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div className="text-[14px] font-medium text-white">Could not prepare the room</div>
        <p className="mt-2 max-w-sm text-[12.5px] text-neutral-500">{bootError}</p>
      </div>
    );
  }
  if (!target) {
    return <div className="grid flex-1 place-items-center p-6 text-[13px] text-neutral-500">Connecting…</div>;
  }
  return <LiveJoined e={e} compact={compact} lockedBy={lockedBy} roomId={target.roomId} devToken={target.devToken} />;
}

function LiveJoined({
  e,
  compact,
  lockedBy,
  roomId,
  devToken,
}: {
  e: ConjunctionEvent;
  compact?: boolean;
  lockedBy?: string;
  roomId: string;
  devToken: string;
}) {
  const [mode, setMode] = useState<StageMode>("voice");
  const call = useCoordinationCall({ roomId, devToken, spaceToTalk: mode === "voice" && !lockedBy });
  const closed = !!e.outcome?.resolvedAt;

  const joinedOnce = useRef(false);
  useEffect(() => {
    if (!compact || closed || joinedOnce.current || call.state !== "idle") return;
    joinedOnce.current = true;
    void call.join();
  }, [compact, closed, call]);

  // resolution / closed case: hang up so LiveKit sessions do not stay open
  useEffect(() => {
    if (!closed) return;
    if (call.state === "joined" || call.state === "reconnecting" || call.state === "joining") void call.leave();
  }, [closed, call]);

  const inCallKey = call.participants.filter((p) => !p.isTranslator).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const speakingKey = call.participants.filter((p) => p.speaking).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const meId = call.identity?.replace(/^user-/, "") ?? null;
  useEffect(() => {
    if (!compact) return;
    useOps.setState({
      callLive: {
        eventId: e.id,
        inCall: inCallKey ? inCallKey.split(",") : [],
        speaking: speakingKey ? speakingKey.split(",") : [],
        messages: call.captions ?? [],
        me: meId,
      },
    });
  }, [compact, e.id, inCallKey, speakingKey, call.captions, meId]);
  useEffect(() => (compact ? () => useOps.setState({ callLive: null }) : undefined), [compact]);

  const lastSaid = useRef<string | null>(null);
  useEffect(() => {
    const myId = call.identity?.replace(/^user-/, "");
    const mine = [...(call.captions ?? [])].reverse().find((m) => m.author.kind === "human" && m.author.userId === myId);
    if (!mine || mine.messageId === lastSaid.current) return;
    lastSaid.current = mine.messageId;
    const label = planNamed(mine.originalText);
    if (label) useOps.setState({ voiceIntent: { eventId: e.id, label, said: mine.originalText, at: Date.now() } });
  }, [call.captions, call.identity, e.id]);

  const flagOf: FlagOf = useMemo(
    () => (p) => {
      if (p.isTranslator) return null;
      if (p.lang) return FLAG_BY_LANG[p.lang] ?? null;
      const id = p.identity.replace(/^user-/, "");
      if (id === "demo-us") return "us";
      if (id === "demo-ru") return "ru";
      if (id === "demo-cn") return "cn";
      return e.parties?.find((x) => x.id === id)?.country ?? null;
    },
    [e.parties],
  );

  return (
    <CallStage
      compact={compact}
      lockedBy={lockedBy}
      call={call}
      mode={mode}
      onMode={setMode}
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

function planNamed(text: string): string | null {
  const t = text.toLowerCase();
  const m = t.match(/\b(?:option|план|вариант|方案|选项)\s*([1-4a-dабвг])\b/i) ?? t.match(/\bp\s*([1-4])\b/i);
  if (!m) return null;
  const k = m[1];
  const n = "abcd".indexOf(k) + 1 || "абвг".indexOf(k) + 1 || Number(k);
  return n >= 1 && n <= 4 ? `P${n}` : null;
}
