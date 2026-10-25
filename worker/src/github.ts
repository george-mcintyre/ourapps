// GitHub build dispatch and read-only workflow status.
import type { Deps, Env } from "./env.js";
import type { AppRow, TestflightBuildRow } from "./db.js";

export interface BuildStatus {
  state: "not-started" | "requested" | "pending" | "running" | "complete" | "failed" | "cancelled" | "unavailable";
  checkedAt: string;
  requestedAt: string | null;
  reason: string | null;
  message: string | null;
  workflowName: string | null;
  runUrl: string | null;
  runId: number | null;
  runNumber: number | null;
  runAttempt: number | null;
  conclusion: string | null;
  // Run timestamps and build numbers give approximate correlation, not verified app or platform identity.
  correlation: "none" | "request-time" | "build-number" | "workflow-only";
  platformVerified: boolean;
  startedAt: string | null;
  elapsedSeconds: number | null;
  expectedSeconds: number | null;
  estimateSampleCount: number;
  estimateSource: "median-successful-job-completion" | null;
  progressPercent: number | null;
}

interface Workflow { id: number; name: string; path: string; state: string }
interface Run {
  id: number;
  workflow_id: number;
  run_number: number;
  run_attempt: number;
  name: string;
  html_url: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
}

class ActionsError extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

async function cacheKey(env: Env, kind: string, scope: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scope)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new URL(`/internal/build-status/${kind}/${hash}`, env.PUBLIC_ORIGIN).href;
}

async function readCache<T>(cache: Cache | null, key: string, now: number): Promise<T | null> {
  try {
    const response = await cache?.match(key);
    if (!response) return null;
    const entry = await response.json() as { expiresAt: number; value: T };
    return entry.expiresAt > now ? entry.value : null;
  } catch { return null; }
}

async function writeCache(cache: Cache | null, key: string, value: unknown, now: number, seconds: number): Promise<void> {
  try {
    await cache?.put(key, new Response(JSON.stringify({ expiresAt: now + seconds * 1000, value }), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
    }));
  } catch { /* Cache failures leave GitHub status available. */ }
}

function withProgress(status: BuildStatus, now: number): BuildStatus {
  if (status.state !== "running") return status;
  const start = status.startedAt ? Date.parse(status.startedAt) : NaN;
  const elapsed = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;
  return { ...status, elapsedSeconds: elapsed, progressPercent: elapsed !== null && status.expectedSeconds ? Math.min(99, Math.floor(elapsed / status.expectedSeconds * 100)) : null };
}

// Edge-local entries contain status or successful durations, never credentials.
export async function loadBuildStatus(env: Env, deps: Deps, app: AppRow, token: string | undefined, builds: TestflightBuildRow[], tokenSavedAt?: string): Promise<BuildStatus> {
  const empty: BuildStatus = {
    state: "not-started", checkedAt: deps.now().toISOString(), requestedAt: app.buildRequestedAt ?? null,
    reason: null, message: null, workflowName: null, runUrl: null, runId: null, runNumber: null, runAttempt: null,
    conclusion: null, correlation: "none", platformVerified: false, startedAt: null, elapsedSeconds: null,
    expectedSeconds: null, estimateSampleCount: 0, estimateSource: null, progressPercent: null,
  };
  if (app.buildRequestError) return { ...empty, state: "failed", reason: "dispatch-failed", message: "The build request could not be sent. Check the GitHub token and repository in settings, then request another build." };
  if (!token) return { ...empty, state: "unavailable", reason: "token-missing", message: "Save a GitHub token with repository access and Actions: read in account settings." };
  if (!/^[\w.-]+\/[\w.-]+$/.test(app.repo)) return { ...empty, state: "unavailable", reason: "repository-missing", message: "Set the app's GitHub repository in app settings." };
  const scope = [app.developerId, app.id, app.platform ?? "ios", app.repo, tokenSavedAt];
  const key = await cacheKey(env, "status", [...scope, app.buildRequestedAt, builds[0]?.buildNumber, builds[0]?.createdAt]);
  let cache: Cache | null = null;
  try { cache = await caches.open("ourapps-build-status"); } catch { /* GitHub reads do not require the cache. */ }
  const cached = await readCache<BuildStatus>(cache, key, deps.now().getTime());
  if (cached) return withProgress(cached, deps.now().getTime());
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const get = async <T>(path: string): Promise<T> => {
    const response = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${app.repo}/actions/${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ourapps", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status === 401 || response.status === 403) throw new ActionsError("actions-access", "GitHub denied access. In account settings, save a valid token with access to this repository and Actions: read. GitHub rate limits can also deny access; retry later.");
    if (response.status === 404) throw new ActionsError("repository-access", "GitHub could not find the repository or workflow. Check repository access and Actions: read on the token in account settings.");
    if (!response.ok) throw new ActionsError("github-error", "GitHub build status is unavailable. Retry shortly.");
    return response.json() as Promise<T>;
  };
  const read = async (): Promise<BuildStatus> => {
    const listing = await get<{ workflows: Workflow[] }>("workflows?per_page=100");
    const workflows = listing.workflows.filter((w) => /(?:^|\/)(?:release|apple-testflight)\.ya?ml$/.test(w.path) && w.state === "active");
    if (!workflows.length) return { ...empty, state: "unavailable", reason: "workflow-missing", message: "No active release.yml or apple-testflight.yml workflow was found in this repository." };
    const groups = await Promise.all(workflows.map(async (workflow) => ({ workflow, runs: (await get<{ workflow_runs: Run[] }>(`workflows/${workflow.id}/runs?per_page=30`)).workflow_runs })));
    const runs = groups.flatMap(({ workflow, runs }) => runs.filter((run) => run.workflow_id === workflow.id).map((run) => ({ run, workflow }))).sort((a, b) => Date.parse(b.run.created_at) - Date.parse(a.run.created_at));
    const requested = app.buildRequestedAt ? Date.parse(app.buildRequestedAt) : null;
    let correlation: BuildStatus["correlation"] = "workflow-only";
    let candidates = runs;
    if (requested !== null) {
      // GitHub timestamps have second precision; dispatch records have millisecond precision.
      candidates = runs.filter(({ run, workflow }) => /(?:^|\/)release\.ya?ml$/.test(workflow.path) && run.event === "repository_dispatch" && Date.parse(run.created_at) >= Math.floor(requested / 1000) * 1000);
      correlation = "request-time";
    }
    const active = candidates.find(({ run }) => run.status !== "completed");
    const latestUpload = builds[0];
    const uploaded = (app.platform ?? "ios") === "ios" && latestUpload && (requested === null || Date.parse(latestUpload.createdAt) >= requested)
      ? runs.filter(({ run, workflow }) => /(?:^|\/)release\.ya?ml$/.test(workflow.path) && String(run.run_number) === latestUpload.buildNumber && Date.parse(run.created_at) <= Date.parse(latestUpload.createdAt) && (requested === null || Date.parse(run.created_at) >= Math.floor(requested / 1000) * 1000)) : [];
    const chosen = active ?? (uploaded.length === 1 ? uploaded[0] : candidates[0]);
    if (!chosen) return { ...empty, state: requested !== null ? "requested" : "not-started", reason: requested !== null ? "awaiting-workflow" : null, message: requested !== null ? "The request was sent; no matching repository-dispatch release run is visible in the recent workflow history." : null };
    if (!active && uploaded.length === 1 && chosen === uploaded[0]) correlation = "build-number";
    const { run, workflow } = chosen;
    let state: BuildStatus["state"];
    if (["queued", "requested", "waiting", "pending"].includes(run.status)) state = "pending";
    else if (run.status === "in_progress") state = "running";
    else if (run.status === "completed") state = run.conclusion === "success" ? "complete" : run.conclusion === "cancelled" ? "cancelled" : run.conclusion ? "failed" : "unavailable";
    else state = "unavailable";
    const status: BuildStatus = { ...empty, state, workflowName: workflow.name, runUrl: /^https:\/\/github\.com\/[^?#]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(run.html_url) ? run.html_url : null,
      runId: run.id, runNumber: run.run_number, runAttempt: run.run_attempt, conclusion: run.conclusion, correlation,
      startedAt: run.run_started_at,
      reason: state === "unavailable" ? "unknown-run-state" : null,
      message: "Workflow status only. GitHub does not expose dispatch app or platform inputs here; completion does not establish TestFlight availability.",
      progressPercent: state === "complete" ? 100 : null };
    const samples = runs.filter(({ run: sample }) => sample.workflow_id === run.workflow_id && sample.id !== run.id && sample.status === "completed" && sample.conclusion === "success").slice(0, 5);
    const durations = await Promise.all(samples.map(async ({ run: sample }) => {
      try {
        const timingKey = await cacheKey(env, "duration", [...scope, sample.workflow_id, sample.id, sample.run_attempt]);
        const cachedSeconds = await readCache<number>(cache, timingKey, deps.now().getTime());
        if (cachedSeconds !== null && Number.isFinite(cachedSeconds) && cachedSeconds > 0) return cachedSeconds;
        const result = await get<{ total_count: number; jobs: { completed_at: string | null }[] }>(`runs/${sample.id}/attempts/${sample.run_attempt}/jobs?per_page=100`);
        if (!sample.run_started_at || !result.jobs.length || result.total_count !== result.jobs.length || result.jobs.some((job) => !job.completed_at)) return null;
        const seconds = (Math.max(...result.jobs.map((job) => Date.parse(job.completed_at!))) - Date.parse(sample.run_started_at)) / 1000;
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        await writeCache(cache, timingKey, seconds, deps.now().getTime(), 900);
        return seconds;
      } catch { return null; }
    }));
    const times = durations.filter((n): n is number => n !== null).sort((a, b) => a - b);
    if (times.length) {
      const middle = Math.floor(times.length / 2);
      status.expectedSeconds = Math.round(times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2);
      status.estimateSampleCount = times.length;
      status.estimateSource = "median-successful-job-completion";
    }
    return withProgress(status, deps.now().getTime());
  };
  let status: BuildStatus;
  try {
    status = await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ActionsError("timeout", "GitHub build status timed out. Retry shortly.")); }, 8000);
    })]);
  } catch (error) {
    status = { ...empty, state: "unavailable", reason: error instanceof ActionsError ? error.reason : "fetch-failed", message: error instanceof ActionsError ? error.message : "GitHub build status could not be read. Retry shortly." };
  } finally { if (timer !== undefined) clearTimeout(timer); }
  await writeCache(cache, key, status, deps.now().getTime(), 15);
  return status;
}

export async function dispatchEvent(env: Env, deps: Deps, token: string | undefined, repo: string, event: string, payload: Record<string, unknown>): Promise<void> {
  if (!token) throw new Error("no GitHub token saved in account settings");
  const res = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "ourapps" },
    body: JSON.stringify({ event_type: event, client_payload: payload }),
  });
  if (res.status !== 204) throw new Error(`repository_dispatch to ${repo}: ${res.status} ${await res.text()}`);
}
