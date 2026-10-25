"use client";

import { ArrowUp, Loader2, Lock } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useMe } from "@/components/auth/session";
import { messagesSendRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { mutate } from "@/lib/backend/run";
import { MAX_TEXT, composerGate, type StageChat } from "./live";
import { useRoomFeed } from "./useRoom";

// Real mode: typed lines go to messages.send (wiring map §3.2). The line is stored at once; translations and the
// Host's replies arrive through messages.list. Typing never approves anything.

/** The counter shows from here, so a short line stays calm. */
const COUNT_FROM = 1600;

export function LiveComposer({ chat, className = "", autoFocus = false }: { chat: StageChat; className?: string; autoFocus?: boolean }) {
  return (
    <QueryBoundary key={chat.roomId} fallback={(e) => <Quiet className={className}>Could not open the room · {briefError(e)}</Quiet>}>
      <Composer chat={chat} className={className} autoFocus={autoFocus} />
    </QueryBoundary>
  );
}

function Composer({ chat, className, autoFocus }: { chat: StageChat; className: string; autoFocus: boolean }) {
  const { room } = useRoomFeed(chat.roomId);
  const role = useMe()?.role;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FORBIDDEN from the server: a head of ops or someone no longer in the room reads only
  const [forbidden, setForbidden] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const gate = composerGate(room, chat.eventId, role);
  const readOnly = forbidden ?? (gate.kind === "read_only" ? gate.why : null);
  if (readOnly) return <Quiet className={className}>{readOnly}</Quiet>;
  const locked = gate.kind === "locked" ? gate.why : null;
  const over = text.length > MAX_TEXT;

  const send = async () => {
    const line = text.trim();
    if (!line || over || sending || locked) return;
    setSending(true);
    setError(null);
    try {
      await mutate(messagesSendRef, { roomId: chat.roomId, ...(chat.eventId ? { eventId: chat.eventId } : {}), text: line });
      setText("");
    } catch (e) {
      // INVALID_STATE (off turn, room closed) also reaches the room projection, which locks the field on its own
      const err = backendError(e);
      if (err.code === "FORBIDDEN") setForbidden(err.message);
      else setError(err.message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  return (
    <div className={`min-w-0 ${className}`}>
      <form
        className="flex h-11 min-w-0 items-center gap-2 rounded-[22px] bg-white/[0.05] pl-4 pr-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-colors focus-within:bg-white/[0.08] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]"
        data-testid="room-composer"
        data-state={locked ? "locked" : "open"}
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        <input
          ref={input}
          value={text}
          disabled={!!locked}
          readOnly={sending}
          autoFocus={autoFocus}
          onChange={(ev) => {
            setText(ev.target.value);
            setError(null);
          }}
          // Space talks in the call; inside the field it types
          onKeyDown={(ev) => ev.stopPropagation()}
          aria-label="Message the room"
          placeholder={locked ? `${locked} · you can type when it is your turn` : "Message the room · each side reads it in their language"}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed"
        />
        {text.length > COUNT_FROM && (
          <span className={`mono tnum shrink-0 text-[11px] ${over ? "text-[#ff8a80]" : "text-neutral-600"}`} data-testid="room-composer-count">
            {text.length} / {MAX_TEXT}
          </span>
        )}
        <button
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black transition-opacity disabled:opacity-25"
          disabled={!!locked || sending || over || !text.trim()}
          aria-label="Send"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.4} />}
        </button>
      </form>
      {error && (
        <div className="mt-1.5 px-4 text-[11.5px] text-[#ff8a80]" role="alert" data-testid="room-composer-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** In place of the field when this reader cannot write: same height, so the dock does not jump. */
function Quiet({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`flex h-11 min-w-0 items-center gap-2 rounded-[22px] bg-white/[0.03] px-4 text-[13px] text-neutral-500 ${className}`} data-testid="room-composer-readonly">
      <Lock size={12} className="shrink-0 text-neutral-600" />
      <span className="truncate">{children}</span>
    </div>
  );
}
