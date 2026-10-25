"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useMe } from "@/components/auth/session";
import { smokeInviteActiveRef, smokeInvitePublishRef } from "@/lib/backend/api";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { QueryBoundary } from "@/lib/backend/QueryBoundary";
import {
  acceptSmokeInvite,
  ingestSmokeInvite,
  isSmokeDemo,
  readSmokeInvite,
  setSmokeInvitePublisher,
  smokeSideFor,
  subscribeSmokeInvites,
  type SmokeInvite,
} from "@/lib/ops/smoke";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";

function parseRemote(eventJson: string, meta: Omit<SmokeInvite, "event">): SmokeInvite | null {
  try {
    return { ...meta, event: JSON.parse(eventJson) as SmokeInvite["event"] };
  } catch {
    return null;
  }
}

/** Toast when US opens the room. Convex is optional; BroadcastChannel always works same-origin. */
export function SmokeInviteToast() {
  if (!isSmokeDemo()) return null;
  return (
    <QueryBoundary fallback={() => <SmokeInviteUi />}>
      {CONVEX_ENABLED ? <SmokeInviteConvexBridge /> : null}
      <SmokeInviteUi />
    </QueryBoundary>
  );
}

/** Cross-laptop invite over Convex. Isolated so a missing function cannot blank the app. */
function SmokeInviteConvexBridge() {
  const publish = useMutation(smokeInvitePublishRef);
  const remote = useQuery(smokeInviteActiveRef, {});

  useEffect(() => {
    setSmokeInvitePublisher((inv) => {
      void publish({
        eventId: inv.eventId,
        pair: inv.pair,
        hostUserId: inv.hostUserId,
        eventJson: JSON.stringify(inv.event),
      }).catch(() => {
        /* Convex not updated yet — local BroadcastChannel still delivers on same origin */
      });
    });
    return () => setSmokeInvitePublisher(null);
  }, [publish]);

  useEffect(() => {
    if (!remote) return;
    const inv = parseRemote(remote.eventJson, {
      eventId: remote.eventId,
      pair: remote.pair,
      openedAt: remote.openedAt,
      hostUserId: remote.hostUserId,
    });
    if (!inv) return;
    ingestSmokeInvite(inv);
    window.dispatchEvent(new CustomEvent("orbitcall-smoke-invite", { detail: inv }));
  }, [remote]);

  return null;
}

function SmokeInviteUi() {
  const me = useMe();
  const incident = useOps((s) => s.incident);
  const [invite, setInvite] = useState<SmokeInvite | null>(() => readSmokeInvite());
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const sounded = useRef<string | null>(null);

  useEffect(() => subscribeSmokeInvites(setInvite), []);
  useEffect(() => {
    const onRemote = (e: Event) => {
      const inv = (e as CustomEvent<SmokeInvite>).detail;
      if (inv) setInvite(inv);
    };
    window.addEventListener("orbitcall-smoke-invite", onRemote);
    return () => window.removeEventListener("orbitcall-smoke-invite", onRemote);
  }, []);

  const side = smokeSideFor(me?.userId);
  const guest = side === "b" || side === "affected";
  const alreadyIn = !!incident && invite && incident === invite.eventId;
  const show = guest && !!invite && !alreadyIn && dismissedId !== invite.eventId;

  useEffect(() => {
    if (!show || !invite) return;
    const key = `${invite.eventId}:${invite.openedAt}`;
    if (sounded.current === key) return;
    sounded.current = key;
    sfx.notice();
  }, [show, invite]);

  return (
    <AnimatePresence>
      {show && invite && (
        <motion.div
          key={invite.eventId}
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -10, opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-auto absolute left-1/2 top-[60px] z-[46] flex -translate-x-1/2 items-center gap-3 rounded-[14px] py-2 pl-3 pr-2 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]"
          style={{
            background: "rgba(8,14,28,0.92)",
            boxShadow: "inset 0 0 0 1px rgba(120,170,255,0.35), 0 12px 40px -10px rgba(0,0,0,0.7)",
            backdropFilter: "blur(16px)",
          }}
          role="status"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(120,170,255,0.15)] text-[11px] font-semibold uppercase tracking-wide text-[#9cc2ff]">
            In
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-white">Coordination invite</div>
            <div className="max-w-[280px] truncate text-[12px] text-neutral-400">
              {invite.pair} · {invite.eventId}
            </div>
          </div>
          <button
            className="btn btn-primary h-8 shrink-0 px-3.5 text-[12.5px]"
            onClick={() => {
              if (!me?.userId) return;
              sfx.whoosh();
              acceptSmokeInvite(me.userId);
              setDismissedId(invite.eventId);
            }}
          >
            Accept
          </button>
          <button
            className="btn btn-ghost-line h-8 shrink-0 px-2.5 text-[12px] text-neutral-400"
            onClick={() => {
              sfx.close();
              setDismissedId(invite.eventId);
            }}
          >
            Later
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
