import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { append, canonical, diff, fail, hash, MAX_ATTEMPTS, MAX_BYTES, parseCommit, parsePrepare, retrySchema, safeError, type Job, type Prepare, type Receipt } from "./protocol.js";

const exec = promisify(execFile);
export type Provider = (input: { cwd: string; home: string; file: string; expected: string }) => Promise<Receipt>;
const clone = <T>(value: T): T => structuredClone(value);
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
export async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail("INVALID_ARTIFACT", "The schedule path must be one bounded regular file.");
  return readFile(path, "utf8");
}
export async function safeDirectory(path: string) {
  if (!await exists(path)) await mkdir(path, { recursive: true, mode: 0o700 });
  // The caller creates only direct children of an already checked directory.
  const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "A workspace directory is unsafe.");
}
export async function atomic(path: string, data: string) {
  const temp = `${path}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, path);
  const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); }
}

/** One OS-locked daemon owns this data directory. A single promise queue serializes all repository operations. */
export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private constructor(readonly root: string, private provider: Provider) {}
  private get repo() { return join(this.root, "repo"); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async idle() { let previous; do { previous = this.tail; await previous; } while (previous !== this.tail); }
  private async git(...args: string[]) {
    const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=OrbitCall Factory", "-c", "user.email=scheduler@orbitcall.invalid", ...args],
      { cwd: this.repo, env: { PATH: process.env.PATH, HOME: join(this.root, "git-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, timeout: 15_000, maxBuffer: 2_000_000 });
    return args[0] === "show" ? stdout : stdout.trimEnd();
  }
  /** Runs a git predicate whose exit code 1 means false; any other failure propagates. */
  private async gitTest(...args: string[]) {
    try { await this.git(...args); return true; }
    catch (e) { if ((e as { code?: unknown }).code === 1) return false; throw e; }
  }
  /** The previewed commit is still in this history and the intent's own file is unchanged since it. */
  private async fileBase(expected: string, commit: string, filePath: string) {
    return await this.gitTest("merge-base", "--is-ancestor", expected, commit) &&
      await this.gitTest("diff", "--quiet", "--no-ext-diff", "--no-textconv", expected, commit, "--", filePath);
  }
  private async blob(commit: string, filePath: string) {
    return await this.git("ls-tree", "--name-only", commit, "--", filePath) ? this.git("show", `${commit}:${filePath}`) : null;
  }
  private async save(job: Job) { await atomic(join(this.root, "jobs", `${job.jobId}.json`), JSON.stringify(job)); }
  async get(id: string): Promise<Job | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return fail("VALIDATION", "Invalid job identifier.", 400);
    const file = join(this.root, "jobs", `${id}.json`); if (!await exists(file)) return null;
    const job = JSON.parse(await readFile(file, "utf8")) as Job;
    // Journals from the initial worker version represent exactly one attempt.
    return { ...job, attempt: job.attempt ?? 1 };
  }
  static async open(root: string, provider: Provider) {
    const e = new Engine(resolve(root), provider);
    await safeDirectory(e.root);
    for (const name of ["repo", "jobs", "staging", "git-home"]) await safeDirectory(join(e.root, name));
    // A crash can leave only the unrenamed temporary file; committed journal files remain authoritative.
    for (const name of await readdir(join(e.root, "jobs"))) if (/^[a-f0-9]{64}\.json\.tmp$/.test(name)) await rm(join(e.root, "jobs", name));
    if (!await exists(join(e.repo, ".git"))) { await e.git("init", "--quiet"); await e.git("commit", "--allow-empty", "-m", "Initialize isolated schedule workspace"); }
    else await safeDirectory(join(e.repo, ".git"));
    const names = (await readdir(join(e.root, "jobs"))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    const jobs = (await Promise.all(names.map(name => e.get(name.slice(0, -5))))).filter((job): job is Job => job?.status === "queued" || job?.status === "running");
    // At most one write runs at a time; recover it before queued writes to other files can commit on top of it.
    jobs.sort((x, y) => Number(y.status === "running") - Number(x.status === "running"));
    for (const job of jobs) {
      if (job.kind === "prepare") {
        job.status = "failed"; job.result = null; job.error = { code: "PREPARE_INTERRUPTED", message: "Factory preparation was interrupted; explicitly retry the same intent." }; await e.save(job);
        await rm(join(e.root, "staging", job.jobId), { recursive: true, force: true });
      }
      else await e.executeCommit(job, true);
    }
    return e;
  }
  private ensureWritable() { if (this.blocked) fail("RECOVERY_REQUIRED", "The schedule workspace requires restart recovery.", 503); }
  private async capacity() { if ((await readdir(join(this.root, "jobs"))).filter(n => n.endsWith(".json")).length >= 1000) fail("LIMIT_EXCEEDED", "The durable job journal requires archival before new intents.", 503); }
  async prepare(raw: unknown): Promise<Job> {
    const request = parsePrepare(raw), jobId = hash(`prepare:${request.intentKey}`);
    const job = await this.serial(async () => {
      this.ensureWritable(); const existing = await this.get(jobId);
      if (existing) { if (canonical(existing.request) !== canonical(request)) fail("INTENT_CONFLICT", "An intent cannot change its immutable request."); return existing; }
      await this.capacity();
      const job: Job = { jobId, intentKey: request.intentKey, kind: "prepare", status: "queued", attempt: 1, request, result: null, error: null };
      await this.save(job); return job;
    });
    if (job.status === "queued") void this.serial(async () => { const current = (await this.get(jobId))!; if (current.status === "queued") await this.executePrepare(current); });
    return clone(job);
  }
  async commit(raw: unknown): Promise<Job> {
    const request = parseCommit(raw), jobId = hash(`commit:${request.intentKey}`);
    const job = await this.serial(async () => {
      this.ensureWritable(); const existing = await this.get(jobId);
      if (existing) { if (canonical(existing.request) !== canonical(request)) fail("INTENT_CONFLICT", "A reserved write cannot change."); return existing; }
      await this.capacity();
      const p = await this.get(request.preparedJobId), artifact = p?.result;
      if (!p || p.kind !== "prepare" || p.status !== "completed" || p.intentKey !== request.intentKey || !artifact ||
        request.contentHash !== artifact.contentHash || request.expectedPreviousHash !== artifact.expectedPreviousHash ||
        request.expectedPreviousCommit !== artifact.expectedPreviousCommit || canonical(request.ref) !== canonical(p.request.ref) || canonical(request.trajectory) !== canonical(p.request.trajectory)) {
        return fail("PREVIEW_MISMATCH", "Commit must reserve the exact completed Factory preview.");
      }
      const job: Job = { jobId, intentKey: request.intentKey, kind: "commit", status: "queued", attempt: 1, request, result: artifact, error: null };
      await this.save(job); return job;
    });
    if (job.status === "queued") void this.serial(async () => { const current = (await this.get(jobId))!; if (current.status === "queued") await this.executeCommit(current, false); });
    return clone(job);
  }
  async retry(jobId: string, raw: unknown): Promise<Job> {
    const parsed = retrySchema.safeParse(raw);
    if (!parsed.success) return fail("VALIDATION", "Retry must identify the observed attempt.", 400);
    const job = await this.serial(async () => {
      this.ensureWritable(); const existing = await this.get(jobId);
      if (!existing) return fail("NOT_FOUND", "Schedule job not found.", 404);
      // A repeated retry command cannot spend again after its first accepted attempt.
      if (existing.attempt > parsed.data.expectedAttempt) return existing;
      if (existing.attempt !== parsed.data.expectedAttempt) return fail("ATTEMPT_CONFLICT", "Retry does not match the observed attempt.");
      if (existing.status === "completed") return existing;
      const allowed = existing.kind === "prepare"
        ? ["WORKER_FAILED", "FACTORY_UNAVAILABLE", "FACTORY_FAILED", "FACTORY_ARTIFACT_INVALID", "PREPARE_INTERRUPTED"]
        : ["WORKER_FAILED"];
      if (existing.status !== "failed" || !existing.error || !allowed.includes(existing.error.code)) return fail("RETRY_UNSAFE", "This failure needs reconciliation or fresh authorization, not a retry.");
      if (existing.attempt >= MAX_ATTEMPTS) return fail("RETRY_LIMIT", "This immutable intent has reached its three-attempt limit.");
      existing.attempt++; existing.status = "queued"; existing.error = null;
      await this.save(existing); return existing;
    });
    if (job.status === "queued") void this.serial(async () => {
      const current = (await this.get(jobId))!;
      if (current.status === "queued") {
        if (current.kind === "prepare") await this.executePrepare(current);
        else await this.executeCommit(current, false);
      }
    });
    return clone(job);
  }
  private async path(filePath: string, base = this.repo) {
    const [operators, company] = filePath.split("/");
    await safeDirectory(join(base, operators)); await safeDirectory(join(base, operators, company));
    return join(base, filePath);
  }
  private async executePrepare(job: Job) {
    const request = job.request as Prepare;
    job.status = "running"; await this.save(job);
    const stage = join(this.root, "staging", job.jobId);
    try {
      this.ensureWritable();
      if (await this.git("status", "--porcelain")) fail("DIRTY_WORKSPACE", "The schedule workspace has unexpected modifications.");
      const file = await this.path(request.filePath), before = await exists(file) ? await regular(file) : null;
      const after = append(before, request), expectedPreviousCommit = await this.git("rev-parse", "HEAD");
      await safeDirectory(stage); const cwd = join(stage, "workspace"), home = join(stage, "home"); await safeDirectory(cwd); await safeDirectory(home);
      const staged = await this.path(request.filePath, cwd);
      // Do not pre-write output: success requires the actual restricted Factory tool invocation.
      const factory = await this.provider({ cwd, home, file: staged, expected: after });
      if (factory.toolWrites !== 1 || !factory.sessionId || !factory.modelId || await regular(staged) !== after) fail("FACTORY_ARTIFACT_INVALID", "Factory did not produce the exact checked schedule artifact.");
      job.result = { filePath: request.filePath, before, after, diff: diff(request.filePath, before, after), contentHash: hash(after),
        expectedPreviousHash: before === null ? null : hash(before), expectedPreviousCommit, factory, commitSha: null };
      job.status = "completed"; await this.save(job);
    } catch (error) { job.status = "failed"; job.result = null; job.error = safeError(error); await this.save(job); }
    finally { await rm(stage, { recursive: true, force: true }); }
  }
  private async executeCommit(job: Job, recovering: boolean) {
    const a = job.result!;
    let writing = false;
    try {
      this.ensureWritable();
      if (!a || a.contentHash !== hash(a.after) || a.diff !== diff(a.filePath, a.before, a.after) || !a.factory.sessionId || a.factory.toolWrites !== 1) fail("INVALID_ARTIFACT", "The durable Factory preview is incomplete.");
      const file = await this.path(a.filePath), head = await this.git("rev-parse", "HEAD"), marker = `OrbitCall intent ${job.jobId}`;
      if (recovering && await exists(`${file}.tmp`)) {
        if (!a.after.startsWith(await regular(`${file}.tmp`))) fail("RECOVERY_CONFLICT", "An interrupted write has unexpected temporary bytes.");
        await rm(`${file}.tmp`);
      }
      if (recovering && await this.git("log", "-1", "--format=%s") === marker) {
        if (!await this.gitTest("merge-base", "--is-ancestor", a.expectedPreviousCommit, "HEAD^") || await this.blob("HEAD^", a.filePath) !== a.before || await regular(file) !== a.after || (await this.git("show", `HEAD:${a.filePath}`)) !== a.after) fail("RECOVERY_CONFLICT", "Committed intent recovery did not match its checked artifact.");
        job.result = { ...a, commitSha: head }; job.status = "completed"; job.error = null; await this.save(job); return;
      }
      // Writes to other files may land after the preview; only this file must be unchanged since it.
      if (!await this.fileBase(a.expectedPreviousCommit, head, a.filePath)) fail("STALE_WORKSPACE", "The schedule changed after this preview; prepare a newly authorized intent.");
      const before = await exists(file) ? await regular(file) : null;
      const normal = before === a.before && (before === null ? null : hash(before)) === a.expectedPreviousHash;
      const interruptedWrite = recovering && before === a.after;
      if (!normal && !interruptedWrite) fail("STALE_WORKSPACE", "The prior schedule bytes differ from the approved preview.");
      const status = await this.git("status", "--porcelain", "--untracked-files=all");
      if (status && (!interruptedWrite || status.split("\n").some(line => line.slice(3) !== a.filePath))) fail("DIRTY_WORKSPACE", "Unexpected workspace modifications prevent a schedule write.");
      job.status = "running"; await this.save(job); writing = true;
      // Only this durable, Factory-produced artifact is copied; no model is called during reserved commit.
      if (!interruptedWrite) await atomic(file, a.after);
      await this.git("add", "--", a.filePath); await this.git("commit", "-m", marker, "--", a.filePath);
      const commitSha = await this.git("rev-parse", "HEAD");
      if (await regular(file) !== a.after) fail("RECOVERY_CONFLICT", "The committed artifact failed its byte check.");
      job.result = { ...a, commitSha }; job.status = "completed"; job.error = null; await this.save(job);
    } catch (error) {
      if (writing) { this.blocked = true; job.status = "running"; job.error = { code: "RECOVERY_REQUIRED", message: "The write outcome needs durable recovery before another write." }; }
      else { job.status = "failed"; job.error = safeError(error); }
      await this.save(job);
    }
  }
}
