import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { callClaude } from "../convex/lib/claude";
import { numbersPreserved } from "../convex/lib/lineTranslation";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogObject, pair, registerSnapshot, type Backend } from "./helpers";

// Typed room lines are translated by messageTranslation.translate (LANG-7): a checked translation reads "ok", a
// changed number, a provider failure or a missing key reads the original, and the author reads the original.

vi.mock("../convex/lib/claude", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/claude")>(), callClaude: vi.fn(),
}));

const send = makeFunctionReference<"mutation">("messages:send");
const list = makeFunctionReference<"query">("messages:list");
const startWorkflow = makeFunctionReference<"mutation">("rooms:startWorkflow");

type View = { text: string; originalText: string; translationStatus: string };
const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
const as = (t: Backend, name: string) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/" });
const reply = (raw: string) => ({ raw, model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
const system = (prompt: { system: string }) => prompt.system;
// Room start also schedules other agents; only the translation prompts count here.
const translationCalls = () => vi.mocked(callClaude).mock.calls.map(([p]) => p).filter(p => p.system.startsWith("You translate one line"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.mocked(callClaude).mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// North (Ana, en) and South (Bo, ru) share the room of one cross-operator event.
async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  await t.mutation(internal.operators.provision, {
    key: "north", name: "North Orbital", simulated: false, objectIds: ["48211"],
    members: [{ tokenIdentifier: token("ana"), role: "operator", assignedObjectIds: ["48211"], name: "Ana Ortiz", language: "en" }],
  });
  await t.mutation(internal.operators.provision, {
    key: "south", name: "South Space", simulated: false, objectIds: ["25544"],
    members: [{ tokenIdentifier: token("bo"), role: "operator", assignedObjectIds: ["25544"], language: "ru" }],
  });
  const snapshotId = await registerSnapshot(t);
  const cross = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...pair(48211, 25544, 15, 1.5e-4) });
  const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: cross.eventId });
  return { t, roomId };
}
// Runs only the translation action, not the 5 s host debounce and its model pipeline.
const translate = async (t: Backend) => { vi.advanceTimersByTime(1); await t.finishInProgressScheduledFunctions(); };
const view = async (t: Backend, who: string, roomId: unknown) => ((await as(t, who).query(list, { roomId })) as View[]).at(-1)!;
const stored = (t: Backend) => t.run(async ctx => (await ctx.db.query("messages").collect()).at(-1)!);

describe("typed line translation", () => {
  it("shows other languages a checked translation, pending until it lands", async () => {
    const { t, roomId } = await seed();
    vi.mocked(callClaude).mockImplementation(async p =>
      reply(system(p).includes("into Russian") ? "Можем сдвинуть на 0.2 м/с в 12:30" : "我们可以在 12:30 移动 0.2 m/s"));
    await as(t, "ana").mutation(send, { roomId, text: "We can move 0.2 m/s at 12:30" });
    expect((await view(t, "bo", roomId)).translationStatus).toBe("pending");
    await translate(t);
    expect(await view(t, "bo", roomId)).toMatchObject({
      text: "Можем сдвинуть на 0.2 м/с в 12:30", originalText: "We can move 0.2 m/s at 12:30", translationStatus: "ok",
    });
    const row = await stored(t);
    expect(row.translationStatus).toEqual({ ru: "ok", zh: "ok" });
    expect(row.translations.zh).toBe("我们可以在 12:30 移动 0.2 m/s");
    const calls = translationCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].user).toBe("We can move 0.2 m/s at 12:30");
  });

  it("lets the author read the original", async () => {
    const { t, roomId } = await seed();
    vi.mocked(callClaude).mockResolvedValue(reply("Можем сдвинуть на 0.2 м/с"));
    await as(t, "ana").mutation(send, { roomId, text: "We can move 0.2 m/s" });
    await translate(t);
    expect(await view(t, "ana", roomId)).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "ok" });
  });

  it("falls back to the original when a translation changes a number, without failing the other language", async () => {
    const { t, roomId } = await seed();
    vi.mocked(callClaude).mockImplementation(async p =>
      reply(system(p).includes("into Russian") ? "Можем сдвинуть на 0.3 м/с" : "我们可以移动 0.2 m/s"));
    await as(t, "ana").mutation(send, { roomId, text: "We can move 0.2 m/s" });
    await translate(t);
    expect(await view(t, "bo", roomId)).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "original_only" });
    const row = await stored(t);
    expect(row.translationStatus).toEqual({ ru: "original_only", zh: "ok" });
    expect(row.translations.ru).toBeUndefined();
  });

  it("falls back to the original when the provider fails", async () => {
    const { t, roomId } = await seed();
    vi.mocked(callClaude).mockRejectedValue(new Error("socket hang up"));
    await as(t, "ana").mutation(send, { roomId, text: "Hold the burn" });
    await translate(t);
    expect(await view(t, "bo", roomId)).toMatchObject({ text: "Hold the burn", translationStatus: "original_only" });
    expect((await stored(t)).translationStatus).toEqual({ ru: "original_only", zh: "original_only" });
  });

  it("sends the line and shows the original when no Claude key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { t, roomId } = await seed();
    await as(t, "ana").mutation(send, { roomId, text: "Hold the burn" });
    expect(await view(t, "bo", roomId)).toMatchObject({ text: "Hold the burn", translationStatus: "original_only" });
    await translate(t);
    expect(translationCalls()).toHaveLength(0);
    expect((await stored(t)).translationStatus).toEqual({});
  });
});

describe("translation deadline", () => {
  it("reads the original once a pending translation is older than the deadline, and the expiry settles it", async () => {
    const { t, roomId } = await seed();
    await as(t, "ana").mutation(send, { roomId, text: "Hold the burn" });   // the action is never run here
    expect((await view(t, "bo", roomId)).translationStatus).toBe("pending");
    vi.setSystemTime(FIXTURE_NOW + 31_000);
    expect(await view(t, "bo", roomId)).toMatchObject({ text: "Hold the burn", translationStatus: "original_only" });
    const expiry = await t.run(async ctx => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter(j => j.name === "messages:storeTranslations"));
    expect(expiry).toHaveLength(1);
    const row = await stored(t);
    await t.mutation(internal.messages.storeTranslations, { messageId: row._id, results: [{ lang: "ru", text: null }, { lang: "zh", text: null }] });
    expect((await stored(t)).translationStatus).toEqual({ ru: "original_only", zh: "original_only" });
  });

  it("never overwrites a translation that already landed", async () => {
    const { t, roomId } = await seed();
    vi.mocked(callClaude).mockResolvedValue(reply("Держим манёвр"));
    await as(t, "ana").mutation(send, { roomId, text: "Hold the burn" });
    await translate(t);
    const row = await stored(t);
    await t.mutation(internal.messages.storeTranslations, { messageId: row._id, results: [{ lang: "ru", text: null }] });
    expect(await view(t, "bo", roomId)).toMatchObject({ text: "Держим манёвр", translationStatus: "ok" });
  });
});

describe("numbersPreserved", () => {
  it("accepts moved numbers and rejects changed, dropped or added ones", () => {
    expect(numbersPreserved("move 0.2 m/s at 12:30", "в 12:30 на 0.2 м/с")).toBe(true);
    expect(numbersPreserved("move 0.2 m/s", "на 0,2 м/с")).toBe(false);
    expect(numbersPreserved("object 25544", "объект")).toBe(false);
    expect(numbersPreserved("hold", "держим 1")).toBe(false);
  });
});
