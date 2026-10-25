import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { backend, catalogObject, type Backend } from "./helpers";

// session.ts is a new function file and convex/_generated is regenerated on main only (#6),
// so the tests reference the functions by path instead of through api.session.
const me = makeFunctionReference<"query">("session:me");
const getMySettings = makeFunctionReference<"query">("session:getMySettings");

const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
const as = (t: Backend, name: string, claims: Record<string, string> = {}) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/", ...claims });

async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "48213", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  const { companyId: northId } = await t.mutation(internal.operators.provision, {
    key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213"],
    members: [
      { tokenIdentifier: token("ana"), role: "operator", assignedObjectIds: ["48212", "48211"] },
      { tokenIdentifier: token("hoa"), role: "head_of_ops", assignedObjectIds: [] },
    ],
  });
  await t.mutation(internal.operators.provision, {
    key: "south", name: "South Space", simulated: true, objectIds: ["25544"],
    members: [{ tokenIdentifier: token("bo"), role: "operator", assignedObjectIds: ["25544"] }],
  });
  return { t, northId };
}

const code = async (p: Promise<unknown>) => ((await p.catch(e => e)) as { data?: { code?: string } }).data?.code;

describe("session.me", () => {
  it("rejects a caller without a sign-in", async () => {
    const { t } = await seed();
    expect(await code(t.query(me, {}))).toBe("UNAUTHENTICATED");
  });

  it("rejects a valid login that was never provisioned", async () => {
    const { t } = await seed();
    expect(await code(as(t, "stranger").query(me, {}))).toBe("FORBIDDEN");
  });

  it("returns the caller, their company and only their active assignments", async () => {
    const { t, northId } = await seed();
    // Reassignment deactivates 48211 and adds 48213; the inactive row must not grant anything.
    await t.mutation(internal.operators.provision, {
      key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213"],
      members: [{ tokenIdentifier: token("ana"), role: "operator", assignedObjectIds: ["48213", "48212"] }],
    });
    const result = await as(t, "ana", { name: "Ana Ortiz" }).query(me, {});
    expect(result).toEqual({
      userId: expect.any(String), name: "Ana Ortiz", role: "operator",
      language: null, dispatcherCountry: null,
      company: { companyId: northId, name: "North Orbital", country: null, simulated: false },
      assignedObjectIds: ["48212", "48213"],
      assignmentVersion: null,
    });
  });

  it("keeps unknown values null instead of guessing them", async () => {
    const { t } = await seed();
    const result = await as(t, "hoa").query(me, {});
    expect(result.name).toBeNull();
    expect(result.role).toBe("head_of_ops");
    expect(result.assignedObjectIds).toEqual([]);
  });

  it("never shows another company's data", async () => {
    const { t } = await seed();
    const result = await as(t, "bo").query(me, {});
    expect(result.company).toMatchObject({ name: "South Space", simulated: true });
    expect(result.assignedObjectIds).toEqual(["25544"]);
  });
});

describe("session.getMySettings", () => {
  it("serves operators their own company's settings, with unstored values null", async () => {
    const { t } = await seed();
    expect(await as(t, "ana").query(getMySettings, {})).toEqual({ language: null, contact: null });
  });

  it("is closed to head of ops and to callers without a sign-in", async () => {
    const { t } = await seed();
    expect(await code(as(t, "hoa").query(getMySettings, {}))).toBe("FORBIDDEN");
    expect(await code(t.query(getMySettings, {}))).toBe("UNAUTHENTICATED");
  });
});

describe("auth.config", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("trusts exactly one Auth0 tenant and audience from the deployment environment", async () => {
    vi.stubEnv("AUTH0_DOMAIN", "orbitcall.us.auth0.com");
    vi.stubEnv("AUTH0_CLIENT_ID", "client-test");
    const { default: config } = await import("../convex/auth.config");
    expect(config).toEqual({ providers: [{ domain: "orbitcall.us.auth0.com", applicationID: "client-test" }] });
  });
});
