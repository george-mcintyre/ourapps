// GitHub build dispatch and read-only workflow status.
import type { Deps, Env } from "./env.js";
import { Db, type AppRow, type BuildRunMetadata, type TestflightBuildRow, type VerifiedBuildRun } from "./db.js";
import { HttpError } from "./http.js";

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
  correlation: "none" | "request-time" | "build-number" | "workflow-only" | "platform-title" | "reservation";
  platformVerified: boolean;
  uploadReceived: boolean | null;
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
  display_title?: string;
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
  return new URL(`/internal/build-status/v3/${kind}/${hash}`, env.PUBLIC_ORIGIN).href;
}

function titlePlatform(run: Run): "macos" | "tvos" | null {
  const marker = /^Apple TestFlight (macos|tvos)(?:\s|$)/.exec(run.display_title ?? "");
  return marker?.[1] === "macos" ? "macos" : marker?.[1] === "tvos" ? "tvos" : null;
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
    conclusion: null, correlation: "none", platformVerified: false, uploadReceived: null, startedAt: null, elapsedSeconds: null,
    expectedSeconds: null, estimateSampleCount: 0, estimateSource: null, progressPercent: null,
  };
  if (app.buildRequestError) return { ...empty, state: "failed", reason: "dispatch-failed", message: "The build request could not be sent. Check the GitHub token and repository in settings, then request another build." };
  if (!token) return { ...empty, state: "unavailable", reason: "token-missing", message: "Save a GitHub token with repository access and Actions: read in account settings." };
  if (!/^[\w.-]+\/[\w.-]+$/.test(app.repo)) return { ...empty, state: "unavailable", reason: "repository-missing", message: "Set the app's GitHub repository in app settings." };
  const scope = [app.developerId, app.id, app.platform ?? "ios", app.repo, tokenSavedAt];
  const key = await cacheKey(env, "status", [...scope, app.buildRequestedAt, builds[0]?.buildNumber, builds[0]?.createdAt]);
  let cache: Cache | null = null;
  try { cache = await caches.open("ourapps-build-status-v3"); } catch { /* GitHub reads do not require the cache. */ }
  const cached = await readCache<BuildStatus>(cache, key, deps.now().getTime());
  if (cached) return withProgress(cached, deps.now().getTime());
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const get = async <T>(path: string): Promise<T> => {
    const response = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${app.repo}/actions/${path}`, {
      signal: controller.signal, redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ourapps", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status >= 300 && response.status < 400) throw new ActionsError("github-redirect", "GitHub redirected the status request; no credentials were forwarded. Check the repository in app settings.");
    if (response.status === 401 || response.status === 403) throw new ActionsError("actions-access", "GitHub denied access. In account settings, save a valid token with access to this repository and Actions: read. GitHub rate limits can also deny access; retry later.");
    if (response.status === 404) throw new ActionsError("repository-access", "GitHub could not find the repository or workflow. Check repository access and Actions: read on the token in account settings.");
    if (!response.ok) throw new ActionsError("github-error", "GitHub build status is unavailable. Retry shortly.");
    return response.json() as Promise<T>;
  };
  const read = async (): Promise<BuildStatus> => {
    const platform = app.platform ?? "ios";
    const nativeApple = platform !== "ios";
    const requested = app.buildRequestedAt ? Date.parse(app.buildRequestedAt) : null;
    const platformBuilds = builds.filter((build) => (build.platform ?? "ios") === platform);
    const outstanding = requested !== null && !platformBuilds.some((build) => Date.parse(build.createdAt) >= requested);
    const missingPlatform = (workflowMissing: boolean): BuildStatus => ({
      ...empty, state: outstanding ? "requested" : "unavailable",
      reason: workflowMissing ? "workflow-missing" : "platform-run-unidentified",
      message: `No identified ${platform === "macos" ? "Mac" : "Apple TV"} build run is visible. ${workflowMissing ? "No active apple-testflight.yml workflow was found." : `The apple-testflight.yml run title must explicitly identify ${platform}.`} General release runs do not establish a build for this platform.`,
    });
    const listing = await get<{ workflows: Workflow[] }>("workflows?per_page=100");
    const workflowPath = nativeApple ? /^\.github\/workflows\/apple-testflight\.yml$/ : /(?:^|\/)release\.ya?ml$/;
    const workflows = listing.workflows.filter((w) => workflowPath.test(w.path) && w.state === "active");
    if (!workflows.length && nativeApple) return missingPlatform(true);
    if (!workflows.length) return { ...empty, state: "unavailable", reason: "workflow-missing", message: "No active release.yml workflow was found for iOS in this repository." };
    const groups = await Promise.all(workflows.map(async (workflow) => ({ workflow, runs: (await get<{ workflow_runs: Run[] }>(`workflows/${workflow.id}/runs?per_page=30`)).workflow_runs })));
    const runs = groups.flatMap(({ workflow, runs }) => runs.filter((run) => run.workflow_id === workflow.id).map((run) => ({ run, workflow }))).sort((a, b) => Date.parse(b.run.created_at) - Date.parse(a.run.created_at));
    const db = Db.from(env);
    const reservations = nativeApple ? await db.buildRunReservations(app.id, platform, app.repo, runs.map(({ run }) => ({ runId: String(run.id), runAttempt: String(run.run_attempt) }))) : [];
    const byAttempt = new Map(reservations.map((reservation) => [`${reservation.runId}/${reservation.runAttempt}`, reservation]));
    const identified = runs.map((entry) => ({ ...entry, reservation: byAttempt.get(`${entry.run.id}/${entry.run.run_attempt}`) ?? null }));
    let correlation: BuildStatus["correlation"] = nativeApple ? "platform-title" : "workflow-only";
    let candidates = nativeApple ? identified.filter(({ run, reservation }) => titlePlatform(run) === platform || (reservation && titlePlatform(run) === null)) : identified;
    if (requested !== null) {
      // GitHub timestamps have second precision; dispatch records have millisecond precision.
      candidates = candidates.filter(({ run }) => (nativeApple || run.event === "repository_dispatch") && Date.parse(run.created_at) >= Math.floor(requested / 1000) * 1000);
      if (!nativeApple) correlation = "request-time";
    }
    const active = candidates.find(({ run }) => run.status !== "completed");
    const latestUpload = builds[0];
    const uploaded = (app.platform ?? "ios") === "ios" && latestUpload && (requested === null || Date.parse(latestUpload.createdAt) >= requested)
      ? identified.filter(({ run, workflow }) => /(?:^|\/)release\.ya?ml$/.test(workflow.path) && String(run.run_number) === latestUpload.buildNumber && Date.parse(run.created_at) <= Date.parse(latestUpload.createdAt) && (requested === null || Date.parse(run.created_at) >= Math.floor(requested / 1000) * 1000)) : [];
    const chosen = active ?? (uploaded.length === 1 ? uploaded[0] : candidates[0]);
    if (!chosen && nativeApple) return missingPlatform(false);
    if (!chosen) return { ...empty, state: requested !== null ? "requested" : "not-started", reason: requested !== null ? "awaiting-workflow" : null, message: requested !== null ? "The request was sent; no matching repository-dispatch release run is visible in the recent workflow history." : null };
    if (!active && uploaded.length === 1 && chosen === uploaded[0]) correlation = "build-number";
    const { run, workflow, reservation } = chosen;
    if (reservation) correlation = "reservation";
    let state: BuildStatus["state"];
    if (["queued", "requested", "waiting", "pending"].includes(run.status)) state = "pending";
    else if (run.status === "in_progress") state = "running";
    else if (run.status === "completed") state = run.conclusion === "success" ? "complete" : run.conclusion === "cancelled" ? "cancelled" : run.conclusion ? "failed" : "unavailable";
    else state = "unavailable";
    const titleBuild = /^Apple TestFlight (?:macos|tvos) (\d+(?:\.\d+){0,2}) \((\d+)\)$/.exec(run.display_title ?? "");
    const pair = reservation ?? (nativeApple && titleBuild ? { version: titleBuild[1]!, buildNumber: titleBuild[2]! } : null);
    const notBefore = new Date(Math.max(Date.parse(run.run_started_at ?? run.created_at), reservation ? Date.parse(reservation.reservedAt) : 0, reservation ? Date.parse(reservation.startedAt) : 0)).toISOString();
    const uploadReceived = nativeApple
      ? pair ? await db.hasBuildUpload(app.id, platform, pair.version, pair.buildNumber, notBefore) : null
      : platformBuilds.some((build) => Date.parse(build.createdAt) >= Date.parse(run.run_started_at ?? run.created_at) && build.buildNumber === String(run.run_number));
    const status: BuildStatus = { ...empty, state, workflowName: workflow.name, runUrl: /^https:\/\/github\.com\/[^?#]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(run.html_url) ? run.html_url : null,
      runId: run.id, runNumber: run.run_number, runAttempt: run.run_attempt, conclusion: run.conclusion, correlation,
      platformVerified: nativeApple && titlePlatform(run) === platform, uploadReceived,
      startedAt: run.run_started_at,
      reason: state === "unavailable" ? "unknown-run-state" : state === "complete" && uploadReceived === null ? "workflow-complete-upload-unconfirmed" : state === "complete" && uploadReceived === false ? "workflow-complete-no-upload" : null,
      message: nativeApple
        ? `${reservation ? "Build identified by a verified run-attempt reservation." : "Platform identified from the workflow title; app and request correlation is approximate."}${state === "complete" && uploadReceived === null ? " Upload receipt is unconfirmed because no version and build pair is identified." : state === "complete" && uploadReceived === false ? " No matching upload received for this platform build." : ""}`
        : "GitHub does not expose dispatch app or platform inputs in its run listing.",
      progressPercent: state === "complete" ? 100 : null };
    const samples = runs.filter(({ run: sample }) => sample.workflow_id === run.workflow_id && sample.id !== run.id && sample.status === "completed" && sample.conclusion === "success" && (!nativeApple || titlePlatform(sample) === platform)).slice(0, 5);
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

export async function dispatchEvent(env: Env, deps: Deps, token: string | undefined, repo: string, event: string, payload: Record<string, unknown>, check?: () => Promise<void>): Promise<void> {
  if (!token) throw new Error("no GitHub token saved in account settings");
  await check?.();
  const res = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${repo}/dispatches`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "ourapps" },
    body: JSON.stringify({ event_type: event, client_payload: payload }),
  });
  if (res.status >= 300 && res.status < 400) throw new Error("GitHub redirected the repository dispatch; no credentials were forwarded. Check the repository in app settings.");
  if (res.status !== 204) throw new Error(`repository_dispatch to ${repo}: ${res.status} ${await res.text()}`);
}

export class GithubBuildRequestError extends Error {}

export function parseBuildRunMetadata(body: unknown): BuildRunMetadata | undefined {
  if (body === undefined) return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Reservation metadata must be a JSON object containing both runId and runAttempt, or neither.");
  const value = body as Record<string, unknown>;
  if (!("runId" in value) && !("runAttempt" in value)) return undefined;
  const positiveId = (input: unknown): string => {
    if ((typeof input !== "string" || !/^\d+$/.test(input)) && typeof input !== "number") throw new HttpError(400, "runId and runAttempt must both be positive safe integers or decimal integer strings.");
    const number = Number(input);
    if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, "runId and runAttempt must both be positive safe integers or decimal integer strings.");
    return String(number);
  };
  return { runId: positiveId(value.runId), runAttempt: positiveId(value.runAttempt) };
}

export async function verifyBuildRun(env: Env, deps: Deps, app: AppRow, token: string, metadata: BuildRunMetadata): Promise<VerifiedBuildRun> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const get = async <T>(path: string): Promise<T> => {
    const response = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${app.repo}/actions/${path}`, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ourapps", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status >= 300 && response.status < 400) throw new HttpError(502, "GitHub redirected run verification; credentials were not forwarded. Check the app repository.");
    if (response.status === 401 || response.status === 403) throw new HttpError(502, "GitHub denied run verification. Grant the saved developer token access to this repository and Actions: read in account settings.");
    if (response.status === 404) throw new HttpError(409, "The supplied run attempt or workflow was not found in this app repository. Check runId and runAttempt.");
    if (!response.ok) throw new HttpError(502, "GitHub run verification is unavailable. Retry without changing runId or runAttempt.");
    return response.json() as Promise<T>;
  };
  const verify = async (): Promise<VerifiedBuildRun> => {
    const run = await get<Run & { repository?: { full_name?: string } }>(`runs/${metadata.runId}/attempts/${metadata.runAttempt}`);
    if (String(run.id) !== metadata.runId || run.repository?.full_name?.toLowerCase() !== app.repo.toLowerCase()) throw new HttpError(400, "The supplied run does not belong to this app repository.");
    if (String(run.run_attempt) !== metadata.runAttempt) throw new HttpError(409, "The supplied runAttempt does not match GitHub's run-attempt identity.");
    if (titlePlatform(run) !== app.platform) throw new HttpError(400, "The GitHub run title does not identify the requested Apple platform.");
    if (!Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0) throw new HttpError(502, "GitHub did not provide a valid workflow identity for the run.");
    const workflow = await get<Workflow>(`workflows/${run.workflow_id}`);
    if (workflow.id !== run.workflow_id || workflow.path !== ".github/workflows/apple-testflight.yml") throw new HttpError(400, "The supplied run must use .github/workflows/apple-testflight.yml in this app repository.");
    if (!Number.isFinite(Date.parse(run.created_at)) || !run.run_started_at || !Number.isFinite(Date.parse(run.run_started_at))) throw new HttpError(502, "GitHub did not provide valid run-attempt timestamps; no build number was allocated.");
    return { ...metadata, repo: app.repo.toLowerCase(), createdAt: new Date(run.created_at).toISOString(), startedAt: new Date(run.run_started_at).toISOString() };
  };
  try {
    return await Promise.race([verify(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new HttpError(502, "GitHub run verification timed out. Retry with the same runId and runAttempt.")); }, 8000);
    })]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "GitHub run verification could not be completed; no build number was allocated.");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// Only release-asset endpoints can redirect; redirected requests carry fixed public headers.
export async function fetchBuildManifest(fetcher: typeof fetch, source: string, headers?: HeadersInit): Promise<Response> {
  const fail = () => new GithubBuildRequestError("The manifest redirect was rejected. Only HTTPS GitHub release-asset redirects to approved GitHub asset hosts are allowed; credentials were not forwarded.");
  try {
    let url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw fail();
    const api = url.hostname === "api.github.com";
    const asset = api && /^\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/\d+$/.test(url.pathname) && !url.search;
    const publicHeaders = { Accept: "application/octet-stream", "User-Agent": "ourapps" };
    const visited = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      if (visited.has(url.href)) throw fail();
      visited.add(url.href);
      const response = await fetcher(url.href, { method: "GET", redirect: "manual", headers: hop === 0 && api ? headers : publicHeaders });
      if (response.status < 300 || response.status >= 400) return response;
      if (!asset || hop === 3 || ![301, 302, 303, 307, 308].includes(response.status)) throw fail();
      const location = response.headers.get("Location");
      if (!location) throw fail();
      const target = new URL(location, url);
      if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash
        || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname)) throw fail();
      url = target;
    }
    throw fail();
  } catch (error) {
    if (error instanceof GithubBuildRequestError) throw error;
    throw new GithubBuildRequestError("The manifest could not be fetched safely. Check the latest release asset; request details and credentials are not included in this error.");
  }
}

export async function dispatchAppleWorkflow(env: Env, deps: Deps, token: string | undefined, repo: string, platform: "macos" | "tvos", version: string, buildNumber: number, check?: () => Promise<void>): Promise<void> {
  const name = platform === "macos" ? "Mac" : "Apple TV";
  if (!token) throw new GithubBuildRequestError(`Save a GitHub token with repository access, Contents: read and Actions: write in account settings to request a ${name} build.`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = async (path: string, body?: unknown): Promise<Response> => {
    const response = await deps.fetch(`${env.GITHUB_API_BASE}/repos/${repo}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: controller.signal, redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "ourapps", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) throw new GithubBuildRequestError(`GitHub redirected the ${name} build request; no credentials were forwarded. Check the repository in app settings.`);
    if (response.status === 401 || response.status === 403) throw new GithubBuildRequestError(`GitHub denied the ${name} build request. Check repository access, Contents: read and Actions: ${body === undefined ? "read" : "write"} on the token in account settings. Workflow dispatch requires Actions: write. GitHub rate limits may also block requests.`);
    if (response.status === 404) throw new GithubBuildRequestError(path === ""
      ? "GitHub could not find the repository. Check the repository and token access in account settings."
      : `GitHub could not find apple-testflight.yml for the ${name} build. Publish .github/workflows/apple-testflight.yml on the repository's default branch and grant the token Actions: write. No release workflow was requested.`);
    if (!response.ok) throw new GithubBuildRequestError(`GitHub could not request the ${name} build (status ${response.status}). Check that apple-testflight.yml accepts platform, version, build and upload inputs, and that the token has Actions: write.`);
    return response;
  };
  const dispatch = async () => {
    const metadata = await (await send("")).json() as { default_branch?: unknown };
    if (typeof metadata.default_branch !== "string" || !metadata.default_branch.trim()) throw new GithubBuildRequestError("GitHub did not report the repository's default branch; the build was not requested.");
    const workflowPath = "/actions/workflows/apple-testflight.yml";
    const workflow = await (await send(workflowPath)).json() as { state?: string };
    if (workflow.state !== "active") throw new GithubBuildRequestError(`Enable .github/workflows/apple-testflight.yml on the repository's default branch before requesting a ${name} build.`);
    if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) throw new GithubBuildRequestError("A safe numeric Apple build number was not reserved; the workflow was not requested.");
    await check?.();
    const response = await send(`${workflowPath}/dispatches`, { ref: metadata.default_branch, inputs: { platform, version, build: String(buildNumber), upload: "true" } });
    if (response.status !== 204) throw new GithubBuildRequestError(`GitHub did not confirm the ${name} workflow dispatch; check apple-testflight.yml and Actions: write in account settings.`);
  };
  try {
    await Promise.race([dispatch(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new GithubBuildRequestError(`The ${name} workflow request timed out. Check GitHub Actions before retrying; dispatch may have been received.`)); }, 8000);
    })]);
  } catch (error) {
    if (error instanceof GithubBuildRequestError || error instanceof HttpError) throw error;
    throw new GithubBuildRequestError(`GitHub could not request the ${name} workflow. Check repository access and Actions: write in account settings, then retry.`);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
