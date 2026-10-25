import type { ConjunctionEvent, Reply } from "@/lib/ops/types";

// The room's shared timeline besides what people say: who approved or vetoed what, which plan is in front of
// both sides, when approvals reset. Every card is canAct: false (spec §3.4, §4.1): reading one never
// approves, selects or schedules anything, and a card never carries a button that does.

export interface RoomCard {
  id: string;
  at: number;
  tone: "ok" | "no" | "reset" | "info";
  title: string;
  detail?: string;
  refs: { eventId: string; label?: string; revision?: number };
  canAct: false;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");

/** Cards for one event from the simulator's record: published revisions and the people's explicit answers. */
export function roomCards(e: ConjunctionEvent, replies: Reply[]): RoomCard[] {
  const who = (side: "a" | "b") => clean(e.parties?.find((p) => p.role === side)?.operator) || `Side ${side.toUpperCase()}`;
  const both = e.b.kind === "debris" ? "approval reset" : "both approvals reset";
  const cards: RoomCard[] = [];
  for (const p of e.proposals ?? []) {
    if (!p.publishedAt || !p.label) continue;
    const plan = p.action === "wait" ? "Both wait for the next CDM" : `${p.mover === "a" ? e.a.name : e.b.name} ${p.action}s ${p.dvMs} m/s`;
    cards.push({
      id: `rev-${p.version}`,
      at: p.publishedAt,
      tone: p.version > 1 ? "reset" : "info",
      title:
        p.by && p.by !== "agents"
          ? `${who(p.by)} selected ${p.label} · R${p.revision ?? 1} for review`
          : p.version > 1
            ? `The agents published ${p.label} · R${p.revision ?? 1}`
            : `Plans ready · ${p.label} · R${p.revision ?? 1} selected`,
      detail: p.version > 1 ? `${plan}. Selecting is not approving: ${both}.` : `${plan}. Both sides approve the same selected plan.`,
      refs: { eventId: e.id, label: p.label, revision: p.revision },
      canAct: false,
    });
  }
  for (const r of replies) {
    if (r.eventId !== e.id || r.via === "select" || r.via === "message" || (r.decision === "countered" && !r.via)) continue;
    const approved = r.decision === "approved";
    cards.push({
      id: `ans-${r.side}-${r.t}`,
      at: r.t,
      tone: approved ? "ok" : "no",
      title: `${who(r.side)} ${approved ? "approved" : "vetoed"}${r.label ? ` ${r.label}` : ""}${r.version ? ` (v${r.version})` : ""}`,
      detail: approved ? "Recorded for this selection only. A new selection or revision resets it." : r.note ? "The agents revise. The reason is in the room, in each reader's language." : "The agents revise.",
      refs: { eventId: e.id, label: r.label },
      canAct: false,
    });
  }
  return cards.sort((x, y) => x.at - y.at);
}
