import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireOperator } from "./lib/operatorAccess";
import { satellitePolicy } from "./lib/policyValidators";
import { changedCategories, validatePolicies } from "./lib/policies";
import { supersede } from "./lib/runs";
import { internal } from "./_generated/api";
import { invalidateEventApprovals } from "./lib/approvalState";

export const getMine = query({
  args: {},
  handler: async ctx => {
    const user = await requireOperator(ctx);
    const policy = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", user.companyId)).unique();
    const company = await ctx.db.get(user.companyId);
    return { satellites: policy?.satellites ?? [], revision: policy?.revision ?? 0,
      updatedAt: policy ? new Date(policy.updatedAt).toISOString() : null, simulated: company?.simulated ?? false };
  },
});

export const update = mutation({
  args: { satellites: v.array(satellitePolicy) },
  returns: v.null(),
  handler: async (ctx, { satellites }) => {
    const user = await requireOperator(ctx);
    validatePolicies(satellites);
    const owned = await ctx.db.query("satelliteOwners").withIndex("by_company", q => q.eq("companyId", user.companyId)).collect();
    if (satellites.some(p => !owned.some(o => o.objectId === p.objectId))) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Policies can be set only for your company's satellites." });
    }
    const previous = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", user.companyId)).unique();
    const sorted = [...satellites].sort((a, b) => a.objectId.localeCompare(b.objectId));
    if (previous && JSON.stringify(previous.satellites) === JSON.stringify(sorted)) return null;
    const categories = changedCategories(previous?.satellites ?? [], sorted);
    const value = { companyId: user.companyId, revision: (previous?.revision ?? 0) + 1, satellites: sorted, updatedAt: Date.now() };
    if (previous) await ctx.db.replace(previous._id, value);
    else await ctx.db.insert("policies", value);

    const sets = [
      ...await ctx.db.query("candidateSets").withIndex("by_company_a", q => q.eq("companyAId", user.companyId)).collect(),
      ...await ctx.db.query("candidateSets").withIndex("by_company_b", q => q.eq("companyBId", user.companyId)).collect(),
    ];
    for (const set of sets) {
      if (set.state === "closed") continue;
      const event = await ctx.db.get(set.eventId);
      if (event) await invalidateEventApprovals(ctx, event, "policy_changed");
      const side = set.companyAId === user.companyId ? "A" as const : "B" as const;
      // Both sides must reconsider: the other Advocate may have relied on the old shared outcome.
      const runs = await ctx.db.query("agentRuns").withIndex("by_event_role_company", q => q.eq("eventId", set.eventId)
        .eq("role", "operator_advocate")).collect();
      for (const run of runs) if (run.status === "running" || run.status === "succeeded") await supersede(ctx, run._id);
      await ctx.db.insert("negotiationMessages", { eventId: set.eventId, side, kind: "policy_changed", categories, entries: [] });
      if (set.state === "scheduled") await ctx.db.patch(set._id, { reviewRequired: true });
      else await ctx.scheduler.runAfter(0, internal.agents.advocate.negotiate, { eventId: set.eventId });
    }
    return null;
  },
});
