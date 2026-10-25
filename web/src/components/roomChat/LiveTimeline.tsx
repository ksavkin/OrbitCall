"use client";

import { AnimatePresence } from "motion/react";
import { useMemo } from "react";
import type { CallMessage } from "@/call/api";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { mergeTimeline, type StageChat } from "./live";
import { LiveItem } from "./LiveLines";
import { usePinnedScroll, useRoomFeed } from "./useRoom";

// Real mode: the call's Text view. The whole room's typed lines (messages.list) with the call's voice phrases, in the
// reader's language; the RoomTimeline look, on the backend's Message shape (wiring map §3).

export function LiveTimeline({ chat, captions, myUserId }: { chat: StageChat; captions: CallMessage[]; myUserId: string | null }) {
  return (
    <QueryBoundary
      key={chat.roomId}
      fallback={(e) => <div className="grid min-h-0 flex-1 place-items-center border-t border-white/[0.06] px-6 text-center text-[13px] text-neutral-500">Could not load the room · {briefError(e)}</div>}
    >
      <Feed chat={chat} captions={captions} myUserId={myUserId} />
    </QueryBoundary>
  );
}

function Feed({ chat, captions, myUserId }: { chat: StageChat; captions: CallMessage[]; myUserId: string | null }) {
  const { room, messages, error } = useRoomFeed(chat.roomId);
  const items = useMemo(() => mergeTimeline(messages ?? [], captions), [messages, captions]);
  // a new line pins again: the reader expects to see what just arrived
  const { box, list } = usePinnedScroll(items.length);
  const empty = error ? `Could not load the room · ${error}` : messages === undefined ? "Opening the room…" : "No messages yet. Type below, or switch to Voice and talk.";
  return (
    <div ref={box} className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06] px-6 py-4" data-testid="call-captions">
      {items.length === 0 && <div className="grid h-full place-items-center text-center text-[13px] text-neutral-500">{empty}</div>}
      <div ref={list} className="flex flex-col gap-3.5 pb-1">
        <AnimatePresence initial={false}>
          {items.map((it) => (
            <LiveItem key={it.key} it={it} room={room} eventId={chat.eventId} myUserId={myUserId} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
