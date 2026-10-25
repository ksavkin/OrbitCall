import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { ensureAssignment, MAX_CONTACT } from "../convex/lib/accounts";
import { backend, catalogObject, type Backend } from "./helpers";

// session.ts is a new function file and convex/_generated is regenerated on main only (#6),
// so the tests reference the functions by path instead of through api.session.
const me = makeFunctionReference<"query">("session:me");
const getMySettings = makeFunctionReference<"query">("session:getMySettings");
const updateMySettings = makeFunctionReference<"mutation">("session:updateMySettings");

const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
const as = (t: Backend, name: string, claims: Record<string, string> = {}) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/", ...claims });
// The error code of a call that must fail. A call that unexpectedly succeeds fails the test with its result.
const code = async (p: Promise<unknown>) => {
  const outcome = await p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  if (outcome.ok) throw new Error(`Expected a failure, got ${JSON.stringify(outcome.value)}`);
  return (outcome.error as { data?: { code?: string } }).data?.code;
};

type Member = { tokenIdentifier: string; role: "operator" | "head_of_ops" | "demo_observer"; assignedObjectIds: string[];
  name?: string; language?: "en" | "ru" | "zh"; dispatcherCountry?: string };
const north = (members: Member[], extra: { country?: string; language?: "en" | "ru" | "zh"; contact?: string } = {}) => ({
  key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213"], members, ...extra,
});
const ana = (assignedObjectIds: string[], extra: Partial<Member> = {}): Member =>
  ({ tokenIdentifier: token("ana"), role: "operator", assignedObjectIds, ...extra });

async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "48213", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  const { companyId: northId } = await t.mutation(internal.operators.provision, north([
    ana(["48212", "48211"], { name: "Ana Ortiz", language: "ru", dispatcherCountry: "RU" }),
    { tokenIdentifier: token("hoa"), role: "head_of_ops", assignedObjectIds: [] },
    { tokenIdentifier: token("eye"), role: "demo_observer", assignedObjectIds: [] },
  ], { country: "US", language: "en", contact: "  ops@north.example  " }));
  await t.mutation(internal.operators.provision, {
    key: "south", name: "South Space", simulated: true, objectIds: ["25544"], contact: "ops@south.example",
    members: [{ tokenIdentifier: token("bo"), role: "operator", assignedObjectIds: ["25544"] }],
  });
  return { t, northId };
}
const provision = (t: Backend, args: ReturnType<typeof north>) => t.mutation(internal.operators.provision, args);
const version = async (t: Backend, name = "ana") => (await as(t, name).query(me, {})).assignmentVersion;
// A row written before assignmentVersion existed: Ana of North with 48211 active and no version.
async function legacyNorth() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212"]) await ctx.db.insert("spaceObjects", catalogObject(id));
    const companyId = await ctx.db.insert("companies", { key: "north", name: "North Orbital", simulated: false });
    const userId = await ctx.db.insert("users", { tokenIdentifier: token("ana"), companyId, role: "operator" });
    await ctx.db.insert("fleetAssignments", { userId, objectId: "48211", active: true });
  });
  return t;
}

describe("session.me", () => {
  it("rejects a caller without a sign-in, and a login that was never provisioned", async () => {
    const { t } = await seed();
    expect(await code(t.query(me, {}))).toBe("UNAUTHENTICATED");
    expect(await code(as(t, "stranger").query(me, {}))).toBe("FORBIDDEN");
  });

  it("returns the stored profile, the company and the active assignments", async () => {
    const { t, northId } = await seed();
    expect(await as(t, "ana").query(me, {})).toEqual({
      userId: expect.any(String), name: "Ana Ortiz", role: "operator", language: "ru", dispatcherCountry: "RU",
      company: { companyId: northId, name: "North Orbital", country: "US", simulated: false },
      assignedObjectIds: ["48211", "48212"], assignmentVersion: 1,
    });
  });

  it("shows only the provisioned name, never the self-editable Auth0 name", async () => {
    const { t } = await seed();
    expect((await as(t, "ana", { name: "Dispatch Control" }).query(me, {})).name).toBe("Ana Ortiz");
    expect((await as(t, "hoa", { name: "Hoa Tran" }).query(me, {})).name).toBeNull();
  });

  it("reads a legacy row without the new fields as null", async () => {
    const t = backend();
    await t.run(async ctx => {
      const companyId = await ctx.db.insert("companies", { key: "old", name: "Old Co", simulated: false });
      const userId = await ctx.db.insert("users", { tokenIdentifier: token("old"), companyId, role: "operator" });
      await ctx.db.insert("fleetAssignments", { userId, objectId: "48211", active: true });
    });
    expect(await as(t, "old").query(me, {})).toMatchObject({
      name: null, language: null, dispatcherCountry: null, assignmentVersion: null,
      company: { country: null }, assignedObjectIds: ["48211"],
    });
  });

  it("never shows another company's data", async () => {
    const { t } = await seed();
    const result = await as(t, "bo").query(me, {});
    expect(result.company).toMatchObject({ name: "South Space", simulated: true, country: null });
    expect(result.assignedObjectIds).toEqual(["25544"]);
  });

  it("serves an observer with no assignments", async () => {
    const { t } = await seed();
    expect(await as(t, "eye").query(me, {})).toMatchObject({ role: "demo_observer", assignedObjectIds: [] });
  });
});

describe("assignment version", () => {
  it("keeps the version on an identical rerun, reordered or with duplicates", async () => {
    const { t } = await seed();
    await provision(t, north([ana(["48211", "48212", "48211"])]));
    expect(await version(t)).toBe(1);
  });

  it("increments once when the active set changes, including a reactivation", async () => {
    const { t } = await seed();
    await provision(t, north([ana(["48212", "48213"])]));
    expect(await version(t)).toBe(2);
    expect((await as(t, "ana").query(me, {})).assignedObjectIds).toEqual(["48212", "48213"]);
    await provision(t, north([ana(["48211", "48212", "48213"])]));   // 48211 reactivated
    expect(await version(t)).toBe(3);
  });

  it("does not move on a profile-only change", async () => {
    const { t } = await seed();
    await provision(t, north([ana(["48211", "48212"], { language: "zh" })]));
    expect(await as(t, "ana").query(me, {})).toMatchObject({ language: "zh", assignmentVersion: 1 });
  });

  it("keeps a legacy user at 1 when its first provisioning leaves the set unchanged", async () => {
    const t = await legacyNorth();
    await provision(t, { ...north([ana(["48211"])]), objectIds: ["48211"] });
    expect(await version(t)).toBe(1);
  });

  it("moves a legacy user to 2 when its first provisioning changes the set", async () => {
    const t = await legacyNorth();
    await provision(t, { ...north([ana(["48211", "48212"])]), objectIds: ["48211", "48212"] });
    expect(await version(t)).toBe(2);
  });

  it("backfills legacy rows to 1 once, and leaves versioned rows alone", async () => {
    const t = await legacyNorth();
    await provision(t, { key: "south", name: "South Space", simulated: true, objectIds: [],
      members: [{ tokenIdentifier: token("bo"), role: "operator", assignedObjectIds: [] }] });
    await t.run(async ctx => {
      const bo = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token("bo"))).unique())!;
      await ctx.db.patch(bo._id, { assignmentVersion: 4 });
    });
    expect(await t.mutation(internal.operators.backfillAssignmentVersions, {})).toEqual({ updated: 1 });
    expect(await t.mutation(internal.operators.backfillAssignmentVersions, {})).toEqual({ updated: 0 });
    expect(await version(t)).toBe(1);
    expect(await version(t, "bo")).toBe(4);
    // After the backfill, an unchanged rerun keeps 1 and a change moves to 2, as for any other user.
    await provision(t, { ...north([ana(["48211"])]), objectIds: ["48211", "48212"] });
    expect(await version(t)).toBe(1);
    await provision(t, { ...north([ana(["48211", "48212"])]), objectIds: ["48211", "48212"] });
    expect(await version(t)).toBe(2);
  });

  it("starts a user created by fixture seeding at 1", async () => {
    const { t, northId } = await seed();
    const userId = await t.run(ctx => ctx.db.insert("users", { tokenIdentifier: token("fx"), companyId: northId, role: "operator" }));
    await t.run(ctx => ensureAssignment(ctx, userId, "48211", true));
    expect(await version(t, "fx")).toBe(1);
  });

  it("fixture seeding adds an assignment without reactivating a revoked one", async () => {
    const { t } = await seed();
    await provision(t, north([ana(["48212"])]));                      // 48211 revoked, version 2
    const userId = (await as(t, "ana").query(me, {})).userId;
    await t.run(ctx => ensureAssignment(ctx, userId, "48211"));
    expect(await as(t, "ana").query(me, {})).toMatchObject({ assignedObjectIds: ["48212"], assignmentVersion: 2 });
    await t.run(ctx => ensureAssignment(ctx, userId, "48213"));
    expect(await as(t, "ana").query(me, {})).toMatchObject({ assignedObjectIds: ["48212", "48213"], assignmentVersion: 3 });
  });
});

describe("provisioning", () => {
  it("updates supplied fields on existing rows and keeps omitted ones", async () => {
    const { t } = await seed();
    await provision(t, north([ana(["48211", "48212"], { dispatcherCountry: "KZ" })], { country: "CA" }));
    expect(await as(t, "ana").query(me, {})).toMatchObject({
      name: "Ana Ortiz", language: "ru", dispatcherCountry: "KZ", company: { country: "CA" },
    });
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: "en", contact: "ops@north.example" });
  });

  it("refuses a satellite that another company already operates", async () => {
    const { t } = await seed();
    const south = { key: "south", name: "South Space", simulated: true, objectIds: ["48211"],
      members: [{ tokenIdentifier: token("bo"), role: "operator" as const, assignedObjectIds: ["48211"] }] };
    expect(await code(t.mutation(internal.operators.provision, south))).toBe("FORBIDDEN");
    expect((await as(t, "bo").query(me, {})).assignedObjectIds).toEqual(["25544"]);
  });

  it("rejects overlong profile text", async () => {
    const { t } = await seed();
    expect(await code(provision(t, north([ana(["48211"], { name: "x".repeat(101) })])))).toBe("VALIDATION");
    expect(await code(provision(t, north([ana(["48211"])], { country: "x".repeat(101) })))).toBe("VALIDATION");
  });

  it("rejects the same account twice in one request, and a padded identifier", async () => {
    const { t } = await seed();
    expect(await code(provision(t, north([ana(["48211"]), ana(["48212"])])))).toBe("VALIDATION");
    expect(await code(provision(t, north([{ ...ana(["48211"]), tokenIdentifier: ` ${token("ana")}` }])))).toBe("VALIDATION");
  });

  it("refuses observer assignments and clears them when an operator becomes an observer", async () => {
    const { t } = await seed();
    expect(await code(provision(t, north([{ tokenIdentifier: token("eye"), role: "demo_observer", assignedObjectIds: ["48211"] }])))).toBe("VALIDATION");
    await provision(t, north([{ ...ana([]), role: "demo_observer" }]));
    expect(await as(t, "ana").query(me, {})).toMatchObject({ role: "demo_observer", assignedObjectIds: [], assignmentVersion: 2 });
  });
});

describe("company settings", () => {
  it("are read by operators and closed to everyone else", async () => {
    const { t } = await seed();
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: "en", contact: "ops@north.example" });
    for (const name of ["hoa", "eye"]) {
      expect(await code(as(t, name).query(getMySettings, {}))).toBe("FORBIDDEN");
      expect(await code(as(t, name).mutation(updateMySettings, { language: "zh" }))).toBe("FORBIDDEN");
    }
    expect(await code(t.query(getMySettings, {}))).toBe("UNAUTHENTICATED");
  });

  it("update only what is supplied, clear a blank contact, and touch only the caller's company", async () => {
    const { t } = await seed();
    expect(await as(t, "ana").mutation(updateMySettings, { language: "zh" })).toBeNull();
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: "zh", contact: "ops@north.example" });
    await as(t, "ana").mutation(updateMySettings, { contact: "   " });
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: "zh", contact: null });
    expect(await as(t, "bo").query(getMySettings, {})).toEqual({ language: null, contact: "ops@south.example" });
  });

  it("reject an overlong contact", async () => {
    const { t } = await seed();
    expect(await code(as(t, "ana").mutation(updateMySettings, { contact: "x".repeat(MAX_CONTACT + 1) }))).toBe("VALIDATION");
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: "en", contact: "ops@north.example" });
  });
});

describe("auth.config", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  // Wiring only: Convex evaluates this file with the deployment's variables, which a unit test cannot see.
  it("builds one Auth0 provider from the two environment values", async () => {
    vi.stubEnv("AUTH0_DOMAIN", "orbitcall.us.auth0.com");
    vi.stubEnv("AUTH0_CLIENT_ID", "client-test");
    const { default: config } = await import("../convex/auth.config");
    expect(config).toEqual({ providers: [{ domain: "orbitcall.us.auth0.com", applicationID: "client-test" }] });
  });
});
