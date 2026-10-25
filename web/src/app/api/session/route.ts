import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Demo sign-in until Auth0 is configured. Usernames and passwords live only in the server environment
// (DEMO_LOGINS = "username:password:accountId,…", SESSION_SECRET = a long random value), never in the
// bundle or in git. A match sets a signed httpOnly cookie that names the demo account; scripts cannot read it.

const COOKIE = "orbitcall_session";
const MAX_AGE = 60 * 60 * 24 * 7;

function logins() {
  return (process.env.DEMO_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().split(":"))
    .filter((p) => p.length === 3 && p.every(Boolean))
    .map(([username, password, accountId]) => ({ username: username.toLowerCase(), password, accountId }));
}

function sign(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(value).digest("base64url");
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The signed-in demo account from the cookie, or null. */
async function current() {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [accountId, exp, mac] = raw.split(".");
  const want = sign(`${accountId}.${exp}`);
  if (!want || !mac || !same(mac, want) || Number(exp) < Date.now()) return null;
  return accountId;
}

export async function GET() {
  return Response.json({ accountId: await current(), configured: logins().length > 0 && !!process.env.SESSION_SECRET });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const hit = logins().find((l) => l.username === username);
  // compare even on a miss so a wrong username and a wrong password take the same time
  const ok = same(password, hit?.password ?? "\u0000".repeat(password.length || 1)) && !!hit;
  if (!ok || !hit) return Response.json({ error: "Wrong username or password." }, { status: 401 });
  const exp = String(Date.now() + MAX_AGE * 1000);
  const mac = sign(`${hit.accountId}.${exp}`);
  if (!mac) return Response.json({ error: "Sign-in is not configured on this server." }, { status: 503 });
  (await cookies()).set(COOKIE, `${hit.accountId}.${exp}.${mac}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: MAX_AGE });
  return Response.json({ accountId: hit.accountId });
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return Response.json({ accountId: null });
}
