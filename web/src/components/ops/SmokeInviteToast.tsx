"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useMe } from "@/components/auth/session";
import { smokeInviteActiveRef, smokeInvitePublishRef } from "@/lib/backend/api";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
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

/** Toast + Convex bridge: when US opens the room, CN/RU Accept → Decision Center + call. */
export function SmokeInviteToast() {
  const me = useMe();
  const incident = useOps((s) => s.incident);
  const [invite, setInvite] = useState<SmokeInvite | null>(() => (isSmokeDemo() ? readSmokeInvite() : null));
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const sounded = useRef<string | null>(null);

  const publish = useMutation(smokeInvitePublishRef);
  const remote = useQuery(smokeInviteActiveRef, isSmokeDemo() && CONVEX_ENABLED ? {} : "skip");

  useEffect(() => {
    if (!isSmokeDemo() || !CONVEX_ENABLED) {
      setSmokeInvitePublisher(null);
      return;
    }
    setSmokeInvitePublisher((inv) => {
      void publish({
        eventId: inv.eventId,
        pair: inv.pair,
        hostUserId: inv.hostUserId,
        eventJson: JSON.stringify(inv.event),
      });
    });
    return () => setSmokeInvitePublisher(null);
  }, [publish]);

  useEffect(() => {
    if (!isSmokeDemo()) return;
    return subscribeSmokeInvites((inv) => setInvite(inv));
  }, []);

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
    setInvite(inv);
  }, [remote]);

  const side = smokeSideFor(me?.userId);
  const guest = side === "b" || side === "affected";
  const alreadyIn = !!incident && invite && incident === invite.eventId;
  const show = isSmokeDemo() && guest && !!invite && !alreadyIn && dismissedId !== invite.eventId;

  useEffect(() => {
    if (!show || !invite) return;
    const key = `${invite.eventId}:${invite.openedAt}`;
    if (sounded.current === key) return;
    sounded.current = key;
    sfx.notice();
  }, [show, invite]);

  if (!isSmokeDemo()) return null;

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
