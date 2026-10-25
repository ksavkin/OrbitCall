#!/usr/bin/env node
// Trusted administrative setup. No deployment, registration, fabricated identities or approvals.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!["--deployment", "--identities", "--apply", "--bootstrap-policies"].includes(key) || flags.has(key)) throw Error(`Unknown or repeated flag: ${key}`);
  if (key === "--apply" || key === "--bootstrap-policies") flags.set(key, true);
  else {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`Missing value for ${key}`);
    flags.set(key, value);
  }
}
const deployment = flags.get("--deployment");
if (!deployment) throw Error("Specify --deployment <name>. Default is a read-only plan; --apply writes it.");
const apply = flags.has("--apply");
const identities = flags.has("--identities") ? JSON.parse(readFileSync(resolve(flags.get("--identities")), "utf8")) : {};
if (!identities || Array.isArray(identities) || typeof identities !== "object") throw Error("Identities must be an object keyed by us, ru, cn, observer.");
const subjects = new Set();
for (const [role, identity] of Object.entries(identities)) {
  if (!["us", "ru", "cn", "observer"].includes(role)) throw Error(`Unknown identity role: ${role}`);
  if (!identity || Object.keys(identity).some(k => !["subject", "name"].includes(k)) || typeof identity.subject !== "string" || !/^[A-Za-z0-9_-]+\|[^\s|]+$/.test(identity.subject) || subjects.has(identity.subject)) {
    throw Error(`Supply a distinct real Auth0 User ID as subject for ${role}; never a password or token.`);
  }
  if (identity.name !== undefined && (typeof identity.name !== "string" || !identity.name.trim() || identity.name.length > 100)) throw Error(`Invalid display name for ${role}`);
  subjects.add(identity.subject);
}

function cli(parts) {
  const r = spawnSync(process.execPath, [join(root, "node_modules/convex/bin/main.js"), ...parts, "--deployment", deployment], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  // Raw errors may include administrative arguments; do not echo them.
  if (r.error || r.status !== 0) throw Error(`Convex ${parts[0]} failed. No automatic retry; inspect the deployment before rerunning.`);
  return r.stdout.trim();
}
const query = source => JSON.parse(cli(["run", "--inline-query", source]));
const run = (fn, input) => JSON.parse(cli(["run", fn, JSON.stringify(input)]));

// Use the frontend's existing demo policy values, rather than inventing a second policy set.
const policySource = readFileSync(join(root, "web/src/components/policy/demoDefaults.ts"), "utf8");
const policyJs = stripTypeScriptTypes(policySource);
const { DEMO_POLICY, DEMO_SETTINGS, utcSlot } = await import(`data:text/javascript;base64,${Buffer.from(policyJs).toString("base64")}`);
const now = new Date();
// Fleets and display names match web/src/components/auth/session.ts. These companies are simulated.
const companies = [
  { role: "us", key: "asd", name: "American Satellite Dynamics", person: "Alex Carter", country: "us", ids: ["56191", "56193", "56200", "62382"] },
  { role: "ru", key: "sever", name: "Sever Imaging", person: "Irina Volkova", country: "ru", ids: ["64880", "64890", "57182", "57178"] },
  { role: "cn", key: "jade", name: "Jade Orbit", person: "Wei Zhang", country: "cn", ids: ["43023", "58646", "58647", "54686"] },
];
function policy(objectId) {
  const source = DEMO_POLICY[objectId];
  if (!source) throw Error(`Missing frontend demo policy for ${objectId}`);
  const { protected: hard, preferred: soft, ...numbers } = source;
  const windows = items => items.map(w => ({ startUtc: `${utcSlot(w.day, w.from, now)}:00.000Z`, endUtc: `${utcSlot(w.day, w.to, now)}:00.000Z`, reason: w.reason }));
  return { objectId, ...numbers, protectedWindows: windows(hard), preferredWindows: windows(soft) };
}

let issuer;
if (subjects.size) {
  const domain = cli(["env", "get", "AUTH0_DOMAIN"]);
  if (!/^[a-zA-Z0-9.-]+\.auth0\.com$/.test(domain)) throw Error("Expected the configured Auth0 tenant host.");
  const response = await fetch(`https://${domain}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error("Cannot read the Auth0 issuer. No accounts were changed.");
  issuer = (await response.json()).issuer;
  if (issuer !== `https://${domain}/`) throw Error("Unexpected Auth0 issuer.");
}

const ids = companies.flatMap(c => c.ids);
const state = query(`const out = {}; for (const table of ["companies", "users", "satelliteOwners", "fleetAssignments", "policies"]) { const rows = await ctx.db.query(table).take(101); if (rows.length === 101) throw Error("Setup scope too large"); out[table] = rows; } out.activeWork = {}; for (const table of ["candidateSets", "approvals", "maneuvers"]) out.activeWork[table] = !!(await ctx.db.query(table).first()); out.objects = []; for (const id of ${JSON.stringify(ids)}) { const o = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", id)).unique(); out.objects.push({ id, exists: !!o }); } return out;`);
if (state.objects.some(o => !o.exists)) throw Error("A demo fleet object is absent from the catalog. Nothing was changed.");

for (const c of companies) {
  const existing = state.companies.filter(row => row.key === c.key);
  if (existing.length > 1 || existing.some(row => row.name !== c.name || row.simulated !== true)) throw Error(`Existing identity conflicts with demo company ${c.key}.`);
  c.companyId = existing[0]?._id;
  for (const id of c.ids) {
    const owners = state.satelliteOwners.filter(row => row.objectId === id);
    if (owners.length > 1 || owners.some(row => row.companyId !== c.companyId)) throw Error(`Existing ownership conflicts for ${id}.`);
  }
  c.members = [];
  const entries = [[c.role, identities[c.role], "operator", c.ids, c.person]];
  if (c.role === "us") entries.push(["observer", identities.observer, "demo_observer", [], "Demo Observer"]);
  for (const [role, identity, userRole, assignedObjectIds, name] of entries) {
    if (!identity) continue;
    const tokenIdentifier = `${issuer}|${identity.subject}`;
    const users = state.users.filter(u => u.tokenIdentifier === tokenIdentifier);
    if (users.length > 1 || users.some(u => u.companyId !== c.companyId || u.role !== userRole)) throw Error(`Existing account conflicts for ${role}.`);
    const user = users[0];
    const active = state.fleetAssignments.filter(a => a.userId === user?._id && a.active).map(a => a.objectId);
    if (active.some(id => !assignedObjectIds.includes(id))) throw Error(`Setup would revoke an assignment for ${role}; refusing.`);
    c.members.push({ tokenIdentifier, role: userRole, assignedObjectIds, name: identity.name?.trim() ?? user?.name ?? name, language: role === "observer" ? "en" : DEMO_SETTINGS[c.key].language, dispatcherCountry: c.country });
  }
  c.policy = c.ids.map(policy).sort((a, b) => a.objectId.localeCompare(b.objectId));
}
const missingPolicies = companies.filter(c => !state.policies.some(p => p.companyId === c.companyId));
if (flags.has("--bootstrap-policies") && missingPolicies.length && (state.policies.length || Object.values(state.activeWork).some(Boolean))) {
  throw Error("Policy bootstrap requires an entirely empty policy table and no candidates, approvals or maneuvers. Use the authenticated policy UI for existing operations.");
}

console.log(JSON.stringify({ deployment, mode: apply ? "apply" : "read-only plan", companies: companies.map(c => ({ key: c.key, name: c.name, simulated: true, objectIds: c.ids, accountsToLink: c.members.length, policy: state.policies.some(p => p.companyId === c.companyId) ? "preserve existing" : flags.has("--bootstrap-policies") ? "seed frontend demo defaults" : "not seeded" })), missingIdentityRoles: ["us", "ru", "cn", "observer"].filter(role => !identities[role]), policyWindowBaseUtc: now.toISOString().slice(0, 10) }, null, 2));
if (!apply) process.exit(0);

for (const c of companies) {
  const input = { key: c.key, name: c.name, simulated: true, objectIds: c.ids, members: c.members };
  // On reruns, preserve company settings edited by the operators.
  if (!c.companyId) Object.assign(input, { country: c.country, ...DEMO_SETTINGS[c.key] });
  c.companyId = run("operators:provision", input).companyId;
}
if (flags.has("--bootstrap-policies") && missingPolicies.length) {
  // Initial data import only. Without --append/--replace, Convex refuses a nonempty table,
  // including a policy inserted concurrently after the preflight. No deployment is pushed.
  const dir = mkdtempSync(join(tmpdir(), "orbitcall-initial-policies-"));
  try {
    const file = join(dir, "policies.json");
    writeFileSync(file, JSON.stringify(companies.map(c => ({ companyId: c.companyId, revision: 1, satellites: c.policy, updatedAt: now.getTime() }))), { mode: 0o600 });
    cli(["import", "--table", "policies", file]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const verification = query(`const out = []; for (const key of ["asd", "sever", "jade"]) { const c = await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", key)).unique(); const users = (await ctx.db.query("users").collect()).filter(u => u.companyId === c._id); const policies = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", c._id)).unique(); const owners = await ctx.db.query("satelliteOwners").withIndex("by_company", q => q.eq("companyId", c._id)).collect(); const members = []; for (const u of users) { const a = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", u._id)).collect(); members.push({ name: u.name, role: u.role, assignedObjectIds: a.filter(r => r.active).map(r => r.objectId), assignmentVersion: u.assignmentVersion }); } out.push({ key, companyId: c._id, simulated: c.simulated, ownedObjects: owners.length, policyObjects: policies?.satellites.length ?? 0, members }); } return out;`);
console.log(JSON.stringify({ verified: verification }, null, 2));
