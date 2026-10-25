import { defineTable } from "convex/server";
import { v } from "convex/values";
import { lang, protectedValue, translations, translationStatus } from "./call";
import { agentSpanValidator, hostOutputValidator } from "../lib/host";
import { checkResultValidator } from "../lib/checker";
import { side } from "../lib/policyValidators";

// Coordination rooms, their text messages and Coordination Host runs (spec §2.3 RoomState, §2.4 Message, §3.4).
// A room groups linked pair events for any number of operator companies; selection and approval stay per event
// (schedule.ts).
// Voice phrases stay in call_phrases; `messages` holds typed text, agent and system lines.

export const agentRole = v.union(
  v.literal("risk_monitor"), v.literal("incident_analyst"), v.literal("operator_advocate"),
  v.literal("coordination_host"), v.literal("maneuver_scheduler"), v.literal("maneuver_verifier"),
  v.literal("second_model"),
);
export const messageKind = v.union(
  v.literal("text"), v.literal("voice"), v.literal("negotiation"), v.literal("system"), v.literal("summary"),
);
export const messageAuthor = v.union(
  v.object({ kind: v.literal("human"), userId: v.id("users"), companyId: v.id("companies"), name: v.string() }),
  v.object({ kind: v.literal("agent"), role: agentRole, companyId: v.union(v.id("companies"), v.null()) }),
  v.object({ kind: v.literal("system") }),
);
export const summaryForm = v.object({
  proposalId: v.id("proposals"), revision: v.number(), movingSide: v.union(side, v.null()),
  burnTimeUtc: v.union(v.string(), v.null()), deltaVMs: v.union(v.number(), v.null()),
  direction: v.union(v.literal("prograde"), v.literal("retrograde"), v.null()), note: v.string(),
});
export const hostTrigger = v.union(
  v.literal("final_message"), v.literal("candidates_changed"), v.literal("summary_requested"), v.literal("call_ended"),
);

export const roomTables = {
  // A room groups all linked pair events for any number of operator companies; nothing caps its size.
  rooms: defineTable({
    state: v.union(v.literal("open"), v.literal("closed")),
    companyIds: v.array(v.id("companies")),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    simulated: v.boolean(),
    createdAt: v.number(), closedAt: v.union(v.number(), v.null()),
  }).index("by_state", ["state"]).index("by_demo_run", ["demoRunId"]),
  // Linked incidents open one room: one row per event in a room. An event is in at most one open room.
  roomEvents: defineTable({
    roomId: v.id("rooms"), eventId: v.id("events"), linkedAt: v.number(),
  }).index("by_room", ["roomId"]).index("by_event", ["eventId"]),
  // Membership comes from involvement in a linked event; it grants reading the room, never approving.
  roomMembers: defineTable({
    roomId: v.id("rooms"), userId: v.id("users"), companyId: v.id("companies"),
    inRoom: v.boolean(), inCall: v.boolean(), updatedAt: v.number(),
  }).index("by_room", ["roomId"]).index("by_room_user", ["roomId", "userId"]).index("by_user", ["userId"]),
  messages: defineTable({
    roomId: v.id("rooms"),
    // Topic of the line, not the whole room.
    eventId: v.union(v.id("events"), v.null()),
    author: messageAuthor, kind: messageKind,
    originalText: v.string(), originalLang: lang,
    translations, translationStatus,
    values: v.array(protectedValue),
    refs: v.object({
      eventId: v.optional(v.id("events")), proposalId: v.optional(v.id("proposals")), revision: v.optional(v.number()),
    }),
    form: v.union(summaryForm, v.null()),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    simulated: v.boolean(),
    createdAt: v.number(),
  }).index("by_room_created", ["roomId", "createdAt"]).index("by_room_event_created", ["roomId", "eventId", "createdAt"])
    .index("by_demo_run", ["demoRunId"]),
  // One Coordination Host attempt, deduplicated by room, input version and trigger. The span, checked output and
  // Grok check are exactly what coordinationHost.run and rationaleCheck.run return; a stale result is superseded.
  hostRuns: defineTable({
    roomId: v.id("rooms"), trigger: hostTrigger, inputVersion: v.string(), attempt: v.number(),
    status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("superseded")),
    span: v.union(agentSpanValidator, v.null()),
    output: v.union(hostOutputValidator, v.null()),
    check: v.union(v.object({ span: agentSpanValidator, result: v.union(checkResultValidator, v.null()) }), v.null()),
    // An old run's host job must not publish into a new run (roadmap §14).
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    createdAt: v.number(), finishedAt: v.union(v.number(), v.null()),
  }).index("by_room_input_trigger", ["roomId", "inputVersion", "trigger"]).index("by_room_created", ["roomId", "createdAt"])
    .index("by_demo_run", ["demoRunId"]),
  // What the agents took from the discussion (spec §2.3 Understood, ROOM-12, LOG-6). `text` is the original in
  // `originalLang`. A correction never edits the old entry: it inserts a new one and marks the old one "corrected"
  // with `correctedById`, so "cannot move Wednesday" corrected to "prefer Thursday" keeps both.
  understood: defineTable({
    roomId: v.id("rooms"), eventId: v.union(v.id("events"), v.null()),
    kind: v.union(
      v.literal("fact"), v.literal("constraint"), v.literal("preference"), v.literal("correction"), v.literal("hypothetical"),
    ),
    hard: v.boolean(),
    text: v.string(), originalLang: lang,
    side: v.union(side, v.null()),
    sourceMessageId: v.id("messages"),
    status: v.union(v.literal("active"), v.literal("corrected")),
    correctedById: v.union(v.id("understood"), v.null()),
    // The Coordination Host run that extracted it; null when entered another way.
    hostRunId: v.union(v.id("hostRuns"), v.null()),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    createdAt: v.number(),
  }).index("by_room_status", ["roomId", "status"]).index("by_event_status", ["eventId", "status"])
    .index("by_demo_run", ["demoRunId"]),
};
