import type { CallMessage } from "@/call/api";
import type { ConjunctionEvent } from "@/lib/ops/types";
import type { RoomCard } from "@/components/roomChat/model";
import { msg } from "./simCall";

// Dev mode's sample room: a coordination call already in progress, so the room's look can be checked without
// running a scan and a case first. Every message state the room can show appears once. All of it is simulated.

const H = 3600_000;
const now = () => Date.now();

export const SAMPLE_ID = "CE-SAMPLE";

export function sampleEvent(): ConjunctionEvent {
  const t = now();
  const tca = t + 26 * H;
  const v1 = { version: 1, mover: "a" as const, action: "raise" as const, burnAt: tca - 6 * H, dvMs: 0.05, fuelKg: 0.0027, missBeforeM: 150, missAfterM: 2840, rationale: "A raises: cheapest option overall.", publishedAt: t - 9 * 60_000, label: "P1", revision: 1, by: "agents" as const };
  const v2 = { ...v1, version: 2, mover: "b" as const, action: "lower" as const, burnAt: tca - 8 * H, fuelKg: 0.0035, missAfterM: 3780, rationale: "Sever Imaging selected P2 for review.", publishedAt: t - 3 * 60_000, label: "P2", revision: 1, by: "b" as const };
  return {
    id: SAMPLE_ID,
    a: { norad: 34510, name: "STARLINK-34510", owner: "US", operator: "SpaceX Starlink", kind: "payload", catalogIndex: null, synthetic: false },
    b: { norad: 90012, name: "LUCH-12 (SYN)", owner: "CIS", operator: "Sever Imaging (synthetic)", kind: "payload", catalogIndex: null, synthetic: true },
    tca,
    missM: 150,
    uncertaintyM: 93,
    radialM: 52,
    pc: 1 / 2300,
    pcSource: "SOCRATES",
    relVelKms: 7.4,
    risk: "red",
    trend: "rising",
    pcHistory: [0, 6, 12, 18, 24].map((h, i) => ({ t: t - (24 - h) * H, pc: [1 / 40000, 1 / 21000, 1 / 9000, 1 / 4100, 1 / 2300][i] })),
    status: "communication",
    agentsWorking: false,
    where: { lat: 53, lon: -106, altKm: 468 },
    proposal: v2,
    proposals: [v1, v2],
    approvals: { a: "pending", b: "approved" },
    summary: null,
    parties: [
      { id: "humanA", role: "a", operator: "SpaceX Starlink", owner: "US", country: "us", language: "English" },
      { id: "humanB", role: "b", operator: "Sever Imaging (synthetic)", owner: "CIS", country: "ru", language: "Russian" },
      { id: "humanC", role: "affected", operator: "Jade Orbit (synthetic)", owner: "PRC", country: "cn", language: "Chinese" },
    ],
    createdAt: t - 40 * 60_000,
    scenario: "sample",
  };
}

/** The conversation so far, oldest first: every state a phrase can be in. */
export function sampleMessages(e: ConjunctionEvent): CallMessage[] {
  const t = now();
  const at = (minAgo: number) => t - minAgo * 60_000;
  const me = { kind: "human" as const, userId: "humanA", companyId: "starlink", name: "SpaceX Starlink", side: null };
  const ru = { kind: "human" as const, userId: "humanB", companyId: "sever", name: "Sever Imaging", side: null };
  const zh = { kind: "human" as const, userId: "humanC", companyId: "jade", name: "Jade Orbit", side: null };
  const host = { kind: "agent" as const, role: "Coordination Host", side: null };
  const list: CallMessage[] = [
    msg(e, host, "en", "Room open for CE-SAMPLE. STARLINK-34510 and LUCH-12 pass 150 m apart, chance 1 in 2,300. Plan P1: STARLINK-34510 raises 0.05 m/s 6 h before closest approach.", "Room open for CE-SAMPLE. STARLINK-34510 and LUCH-12 pass 150 m apart, chance 1 in 2,300. Plan P1: STARLINK-34510 raises 0.05 m/s 6 h before closest approach.", at(9)),
    msg(e, me, "en", "We can raise our orbit by 0.05 m/s at 02:40 UTC. Does that work for you?", "We can raise our orbit by 0.05 m/s at 02:40 UTC. Does that work for you?", at(8)),
    msg(e, ru, "ru", "Мы предпочли бы сами снизиться на 0.05 m/s, у нас окно съёмки в 04:10 UTC.", "We'd rather lower ourselves by 0.05 m/s, we have an imaging window at 04:10 UTC.", at(6)),
    msg(e, zh, "zh", "我们的卫星 JADE-3 在 470 km，这个方案不影响我们。", "Our satellite JADE-3 is at 470 km, this plan does not affect us.", at(5)),
    { ...msg(e, ru, "ru", "Тогда выбираю P2 и подтверждаю с нашей стороны.", "Then I select P2 and confirm on our side.", at(3)), voiceError: { code: "VOICE_UNAVAILABLE", message: "no voice configured for en" } },
    { ...msg(e, zh, "zh", "请确认点火时间是 00:40 UTC 还是 02:40 UTC。", "请确认点火时间是 00:40 UTC 还是 02:40 UTC。", at(2)), translationStatus: "original_only", translationError: { code: "VALUE_CHECK", message: "a protected value changed in translation" } },
    { ...msg(e, ru, "ru", "Ждём вашего подтверждения по P2.", "Ждём вашего подтверждения по P2.", at(0.3)), translationStatus: "pending" },
  ];
  return list;
}

/** Room records between the messages: plan ready, an approval, the reset when P2 was selected. */
export function sampleCards(e: ConjunctionEvent): RoomCard[] {
  const t = now();
  return [
    { id: "s-rev1", at: t - 9 * 60_000 + 1000, tone: "info", title: "Plans ready · P1 · R1 selected", detail: "STARLINK-34510 raises 0.05 m/s. Both sides approve the same selected plan.", refs: { eventId: e.id, label: "P1", revision: 1 }, canAct: false },
    { id: "s-rev2", at: t - 3 * 60_000 + 1000, tone: "reset", title: "Sever Imaging selected P2 · R1 for review", detail: "LUCH-12 lowers 0.05 m/s. Selecting is not approving: both approvals reset.", refs: { eventId: e.id, label: "P2", revision: 1 }, canAct: false },
    { id: "s-ok", at: t - 2.5 * 60_000, tone: "ok", title: "Sever Imaging approved P2", detail: "Recorded for this selection only. A new selection or revision resets it.", refs: { eventId: e.id, label: "P2" }, canAct: false },
  ];
}
