import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRow, TestflightBuildRow } from "../src/db.js";
import { fetchBuildManifest, loadBuildStatus } from "../src/github.js";
import { clearDb, fakeFetch, jsonRes, testDeps, testEnv } from "./helpers.js";

const token = "private-test-token";
const app = { id: "app", developerId: "developer", repo: "o/app", platform: "ios" } as AppRow;
const release = { id: 1, name: "release", path: ".github/workflows/release.yml", state: "active" };
const manual = { id: 2, name: "apple-platform-testflight", path: ".github/workflows/apple-testflight.yml", state: "active" };
const run = (overrides = {}) => ({ id: 101, workflow_id: 1, run_number: 7, run_attempt: 1, name: "release", html_url: "https://github.com/o/app/actions/runs/101", event: "repository_dispatch", status: "in_progress", conclusion: null, created_at: "2026-10-16T09:58:00Z", run_started_at: "2026-10-16T09:59:00Z", ...overrides });
const prefix = "GET api.github.com/repos/o/app/actions/";
function routes(runs = [run()], workflows = [release]) {
  return {
    [`${prefix}workflows`]: () => jsonRes({ workflows }),
    [`${prefix}workflows/1/runs`]: () => jsonRes({ workflow_runs: runs }),
    [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [] }),
  };
}

let entries: Map<string, Response>;
let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  await clearDb(testEnv());
  entries = new Map();
  cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()); }),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GitHub build status", () => {
  it.each([
    ["queued", null, "pending"], ["requested", null, "pending"], ["waiting", null, "pending"], ["pending", null, "pending"],
    ["in_progress", null, "running"], ["completed", "success", "complete"], ["completed", "failure", "failed"],
    ["completed", "timed_out", "failed"], ["completed", "cancelled", "cancelled"], ["completed", "skipped", "failed"],
    ["completed", null, "unavailable"], ["future-state", null, "unavailable"],
  ])("maps %s/%s to %s", async (status, conclusion, state) => {
    const github = fakeFetch(routes([run({ status, conclusion })]));
    const result = await loadBuildStatus(testEnv(), testDeps(github.fetch), app, token, []);
    expect(result.state).toBe(state);
    expect(result.workflowName).toBe("release");
    expect(result.platformVerified).toBe(false);
    expect(result.expectedSeconds).toBeNull();
    expect(result.progressPercent).toBe(state === "complete" ? 100 : null);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(github.calls.every((call) => call.headers.get("Authorization") === `Bearer ${token}`)).toBe(true);
  });

  it("ignores unrelated workflows and old runs after a new request", async () => {
    const github = fakeFetch(routes([run({ created_at: "2026-10-15T10:00:00Z", status: "completed", conclusion: "success" }), run({ workflow_id: 99 })], [release, { ...release, id: 99, path: ".github/workflows/ci.yml" }]));
    const status = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, buildRequestedAt: "2026-10-16T09:59:00Z" }, token, []);
    expect(status).toMatchObject({ state: "requested", reason: "awaiting-workflow", runId: null });
    expect(github.calls).toHaveLength(2);
  });

  it("prefers an active dispatch after the request, without claiming exact correlation", async () => {
    const github = fakeFetch(routes([
      run({ id: 104, created_at: "2026-10-16T10:02:00Z", status: "completed", conclusion: "failure" }),
      run({ id: 103, created_at: "2026-10-16T10:01:00Z", event: "workflow_dispatch" }),
      run({ id: 102, created_at: "2026-10-16T10:00:00Z", status: "queued" }),
    ]));
    const status = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, buildRequestedAt: "2026-10-16T10:00:00.123Z" }, token, []);
    expect(status).toMatchObject({ state: "pending", runId: 102, correlation: "request-time", platformVerified: false });
    expect(status.message).toContain("does not expose dispatch app or platform");
  });

  it.each([null, "2026-10-16T09:57:00Z"])("uses the uploaded iOS run number rather than the run identifier after request %s", async (buildRequestedAt) => {
    const github = fakeFetch(routes([
      run({ id: 900, run_number: 8, status: "completed", conclusion: "failure" }),
      run({ id: 901, run_number: 7, status: "completed", conclusion: "success" }),
    ]));
    const builds = [{ buildNumber: "7", createdAt: "2026-10-16T10:00:00Z" }] as TestflightBuildRow[];
    const status = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, buildRequestedAt }, token, builds);
    expect(status).toMatchObject({ state: "complete", runId: 901, runNumber: 7, correlation: "build-number", platformVerified: false });
  });

  it.each([null, "2026-10-16T09:57:00Z"])("rejects a generic manual Apple title with request %s", async (buildRequestedAt) => {
    const github = fakeFetch({ ...routes([], [manual]), [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [run({ workflow_id: 2, status: "completed", conclusion: "success" })] }) });
    const builds = [{ buildNumber: "7", createdAt: "2026-10-16T10:00:00Z" }] as TestflightBuildRow[];
    const status = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, platform: "macos", buildRequestedAt }, token, builds);
    expect(status).toMatchObject({ state: buildRequestedAt ? "requested" : "unavailable", workflowName: null, correlation: "none", platformVerified: false, reason: "platform-run-unidentified" });
  });

  it("estimates from job completion times of up to five successes in the same workflow", async () => {
    const history = [120, 180, 240, 300, 360, 999].map((seconds, index) => run({ id: 200 + index, status: "completed", conclusion: "success", created_at: `2026-10-${15 - index}T09:59:00Z`, run_started_at: "2026-10-10T09:00:00Z", updated_at: "2026-10-16T09:59:00Z", seconds }));
    const stubs = routes([run(), ...history]);
    for (const [index, sample] of history.entries()) Object.assign(stubs, { [`${prefix}runs/${sample.id}/attempts/1/jobs`]: () => jsonRes({ total_count: 1, jobs: [{ completed_at: new Date(Date.parse(sample.run_started_at!) + [120, 180, 240, 300, 360, 999][index]! * 1000).toISOString() }] }) });
    const github = fakeFetch(stubs);
    const deps = testDeps(github.fetch);
    const status = await loadBuildStatus(testEnv(), deps, app, token, []);
    expect(status).toMatchObject({ state: "running", elapsedSeconds: 60, expectedSeconds: 240, estimateSampleCount: 5, estimateSource: "median-successful-job-completion", progressPercent: 25 });
    expect(github.calls.filter((call) => call.url.includes("/jobs?"))).toHaveLength(5);
    deps.advance(10000);
    const cached = await loadBuildStatus(testEnv(), deps, app, token, []);
    expect(cached.elapsedSeconds).toBe(70);
    expect(github.calls).toHaveLength(7);
    deps.advance(300000);
    expect((await loadBuildStatus(testEnv(), deps, app, token, [])).progressPercent).toBe(99);
    expect(github.calls.filter((call) => call.url.includes("/jobs?"))).toHaveLength(5);
    expect(github.calls).toHaveLength(9);
    deps.advance(600000);
    await loadBuildStatus(testEnv(), deps, app, token, []);
    expect(github.calls.filter((call) => call.url.includes("/jobs?"))).toHaveLength(10);
  });

  it("leaves the estimate unknown when historical job times cannot be read", async () => {
    const github = fakeFetch(routes([run(), run({ id: 99, status: "completed", conclusion: "success" })]));
    expect(await loadBuildStatus(testEnv(), testDeps(github.fetch), app, token, [])).toMatchObject({ state: "running", expectedSeconds: null, estimateSampleCount: 0, progressPercent: null });
  });

  it.each([401, 403, 404, 500])("reports GitHub %s without exposing its response", async (code) => {
    const github = fakeFetch({ [`${prefix}workflows`]: () => new Response(token, { status: code }) });
    const status = await loadBuildStatus(testEnv(), testDeps(github.fetch), app, token, []);
    expect(status.state).toBe("unavailable");
    if (code < 500) expect(status.message).toContain("Actions: read");
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("handles fetch exceptions without exposing exception text", async () => {
    const deps = testDeps(async () => { throw new Error(token); });
    expect(await loadBuildStatus(testEnv(), deps, app, token, [])).toMatchObject({ state: "unavailable", reason: "fetch-failed", message: "GitHub build status could not be read. Retry shortly." });
  });

  it("rejects GitHub status redirects without forwarding credentials", async () => {
    const github = fakeFetch({ [`${prefix}workflows`]: () => new Response(null, { status: 302, headers: { Location: "https://other.invalid/credentials" } }) });
    const deps = testDeps(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      return github.fetch(input, init);
    });
    expect(await loadBuildStatus(testEnv(), deps, app, token, [])).toMatchObject({ state: "unavailable", reason: "github-redirect" });
    expect(github.calls).toHaveLength(1);
  });

  it("times out a stalled GitHub request and aborts it", async () => {
    let signal: AbortSignal | null | undefined;
    const deps = testDeps(async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    expect(await loadBuildStatus(testEnv(), deps, app, token, [])).toMatchObject({ state: "unavailable", reason: "timeout" });
    expect(signal?.aborted).toBe(true);
  }, 10000);

  it("reports missing workflows, missing tokens, dispatch failure and no runs honestly", async () => {
    const env = testEnv();
    const deps = testDeps(fakeFetch(routes([], [])).fetch);
    expect((await loadBuildStatus(env, deps, app, undefined, [])).reason).toBe("token-missing");
    expect(await loadBuildStatus(env, deps, { ...app, buildRequestError: token }, token, [])).toMatchObject({ state: "failed", reason: "dispatch-failed" });
    expect(await loadBuildStatus(env, deps, app, token, [])).toMatchObject({ state: "unavailable", reason: "workflow-missing" });
    expect(await loadBuildStatus(env, testDeps(fakeFetch(routes([])).fetch), { ...app, id: "empty" }, token, [])).toMatchObject({ state: "not-started", runId: null });
  });

  it("isolates cache entries and invalidates them for requests and credential changes", async () => {
    const github = fakeFetch(routes());
    const deps = testDeps(github.fetch);
    const env = testEnv();
    await loadBuildStatus(env, deps, app, token, [], "revision1");
    await loadBuildStatus(env, deps, app, token, [], "revision1");
    expect(github.calls).toHaveLength(2);
    for (const changed of [{ ...app, developerId: "other" }, { ...app, platform: "tvos" as const }, { ...app, buildRequestedAt: deps.now().toISOString() }]) await loadBuildStatus(env, deps, changed, token, [], "revision1");
    await loadBuildStatus(env, deps, app, token, [], "revision2");
    expect(github.calls).toHaveLength(9);
    expect(entries.size).toBe(5);
    for (const [key, response] of entries) {
      expect(key).not.toContain(token);
      expect(await response.clone().text()).not.toContain(token);
      expect(response.headers.get("Cache-Control")).toBe("max-age=15");
    }
  });

  it("refreshes status after 15 seconds without making key-value writes", async () => {
    const env = testEnv();
    const put = vi.spyOn(env.WEBAPP_FILES, "put");
    const github = fakeFetch(routes());
    const deps = testDeps(github.fetch);
    await loadBuildStatus(env, deps, app, token, []);
    deps.advance(14999);
    await loadBuildStatus(env, deps, app, token, []);
    expect(github.calls).toHaveLength(2);
    deps.advance(1);
    await loadBuildStatus(env, deps, app, token, []);
    expect(github.calls).toHaveLength(4);
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["open", "match", "put"])("returns status when cache %s fails", async (operation) => {
    if (operation === "open") vi.mocked(caches.open).mockRejectedValue(new Error("cache unavailable"));
    else cache[operation as "match" | "put"].mockRejectedValue(new Error("cache unavailable"));
    const github = fakeFetch(routes());
    expect(await loadBuildStatus(testEnv(), testDeps(github.fetch), app, token, [])).toMatchObject({ state: "running", runId: 101 });
    expect(github.calls).toHaveLength(2);
  });

  it("does not let cached successful status mask a credential revision with denied access", async () => {
    const github = fakeFetch(routes());
    const deps = testDeps(github.fetch);
    const env = testEnv();
    await loadBuildStatus(env, deps, app, token, [], "revision1");
    const denied = fakeFetch({ [`${prefix}workflows`]: () => new Response("private error", { status: 403 }) });
    const restricted = { ...deps, fetch: denied.fetch };
    const status = await loadBuildStatus(env, restricted, app, token, [], "revision2");
    expect(status).toMatchObject({ state: "unavailable", reason: "actions-access" });
    expect(status.message).toContain("Actions: read");
    expect(await loadBuildStatus(env, restricted, app, token, [], "revision2")).toEqual(status);
    expect(denied.calls).toHaveLength(1);
    deps.advance(15000);
    await loadBuildStatus(env, restricted, app, token, [], "revision2");
    expect(denied.calls).toHaveLength(2);
  });

  it.each(["macos", "tvos"] as const)("never treats a general release as a %s platform build", async (platform) => {
    for (const [index, status] of ["completed", "in_progress", "queued"].entries()) {
      const github = fakeFetch(routes([run({ run_number: 37, status, conclusion: status === "completed" ? "success" : null })]));
      const result = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, id: `${platform}-${index}`, platform, buildRequestedAt: "2026-10-16T09:57:00Z" }, token, []);
      expect(result).toMatchObject({ state: "requested", runId: null, workflowName: null, platformVerified: false, reason: "workflow-missing" });
      expect(result.message).toContain(`No identified ${platform === "macos" ? "Mac" : "Apple TV"} build run`);
      expect(github.calls).toHaveLength(1);
    }
  });

  it.each(["macos", "tvos"] as const)("rejects another platform's title for %s", async (platform) => {
    const other = platform === "macos" ? "tvos" : "macos";
    const github = fakeFetch({ ...routes([run({ status: "completed", conclusion: "success" })], [release, manual]),
      [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [run({ workflow_id: 2, display_title: `Apple TestFlight ${other} 1.2.3 (9)`, status: "completed", conclusion: "success" })] }),
    });
    const result = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, platform }, token, []);
    expect(result).toMatchObject({ state: "unavailable", reason: "platform-run-unidentified", runId: null });
    expect(github.calls.some((call) => call.url.includes("workflows/1/runs"))).toBe(false);
  });

  it.each(["macos", "tvos"] as const)("selects canonical %s titles for queued, running and completed runs", async (platform) => {
    for (const [index, status] of ["queued", "in_progress", "completed"].entries()) {
      const github = fakeFetch({ ...routes([], [manual]),
        [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [run({ workflow_id: 2, display_title: `Apple TestFlight ${platform} 1.2.3 (9)`, status, event: "workflow_dispatch", conclusion: status === "completed" ? "success" : null })] }),
      });
      const result = await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, id: `${platform}-${index}`, platform, buildRequestedAt: "2026-10-16T09:57:00Z" }, token, []);
      expect(result).toMatchObject({ state: status === "queued" ? "pending" : status === "in_progress" ? "running" : "complete", workflowName: "apple-platform-testflight", correlation: "platform-title", platformVerified: true, uploadReceived: false });
      if (status === "completed") {
        expect(result.reason).toBe("workflow-complete-no-upload");
        expect(result.message).toContain("No matching upload received");
      }
    }
  });

  it("does not select native Apple runs for iOS", async () => {
    const github = fakeFetch(routes([], [manual]));
    expect(await loadBuildStatus(testEnv(), testDeps(github.fetch), app, token, [])).toMatchObject({ state: "unavailable", reason: "workflow-missing", runId: null });
    expect(github.calls).toHaveLength(1);
  });

  it("uses the title build number and platform for received upload evidence", async () => {
    const github = fakeFetch({ ...routes([], [manual]),
      [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [run({ workflow_id: 2, display_title: "Apple TestFlight macos 1.2.3 (99)", status: "completed", conclusion: "success" })] }),
    });
    const builds = [
      { platform: "tvos", version: "1.2.3", buildNumber: "99", createdAt: "2026-10-16T09:59:00Z" },
      { platform: "macos", version: "1.2.3", buildNumber: "7", createdAt: "2026-10-16T09:59:00Z" },
    ] as TestflightBuildRow[];
    const deps = testDeps(github.fetch);
    expect(await loadBuildStatus(testEnv(), deps, { ...app, platform: "macos" }, token, builds)).toMatchObject({ state: "complete", uploadReceived: false, reason: "workflow-complete-no-upload" });
    deps.advance(15000);
    builds.push({ platform: "macos", version: "1.2.3", buildNumber: "99", createdAt: "2026-10-16T09:59:00Z" } as TestflightBuildRow);
    expect(await loadBuildStatus(testEnv(), deps, { ...app, platform: "macos" }, token, builds)).toMatchObject({ state: "complete", uploadReceived: true, reason: null });
  });

  it("uses only same-platform title timing samples and a new cache namespace", async () => {
    const github = fakeFetch({ ...routes([], [manual]),
      [`${prefix}workflows/2/runs`]: () => jsonRes({ workflow_runs: [
        run({ workflow_id: 2, display_title: "Apple TestFlight tvos 1.2.3 (9)" }),
        run({ id: 200, workflow_id: 2, display_title: "Apple TestFlight macos 1.2.3 (8)", status: "completed", conclusion: "success" }),
        run({ id: 201, workflow_id: 2, display_title: "Apple TestFlight tvos 1.2.3 (7)", status: "completed", conclusion: "success" }),
        run({ id: 202, workflow_id: 2, display_title: "apple-platform-testflight", status: "completed", conclusion: "success" }),
      ] }),
      [`${prefix}runs/201/attempts/1/jobs`]: () => jsonRes({ total_count: 1, jobs: [{ completed_at: "2026-10-16T10:00:00Z" }] }),
    });
    expect(await loadBuildStatus(testEnv(), testDeps(github.fetch), { ...app, platform: "tvos" }, token, [])).toMatchObject({ state: "running", expectedSeconds: 60, estimateSampleCount: 1 });
    expect(github.calls.filter((call) => call.url.includes("/jobs?"))).toHaveLength(1);
    expect(caches.open).toHaveBeenCalledWith("ourapps-build-status-v2");
    expect([...entries.keys()].every((key) => key.includes("/build-status/v2/"))).toBe(true);
  });
});

describe("private build manifest redirects", () => {
  const source = "https://api.github.com/repos/o/app/releases/assets/123";

  it("follows private asset redirects using GET without forwarding any credential headers", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) return new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/object?signature=private" } });
      if (requests.length === 2) return new Response(null, { status: 307, headers: { Location: "https://objects.githubusercontent.com/object?signature=private" } });
      return new Response('{"version":"1.2.3"}');
    };
    const response = await fetchBuildManifest(fetcher, source, { Authorization: `Bearer ${token}`, Cookie: "session=private", "Proxy-Authorization": "private", "X-Api-Key": "private", "X-Custom-Secret": "private" });
    expect(await response.json()).toEqual({ version: "1.2.3" });
    expect(requests[0]!.headers.get("Authorization")).toBe(`Bearer ${token}`);
    for (const request of requests.slice(1)) {
      expect([...request.headers.keys()].sort()).toEqual(["accept", "user-agent"]);
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("manual");
    }
  });

  it.each([
    "https://other.invalid/object", "https://release-assets.githubusercontent.com.other.invalid/object",
    "http://release-assets.githubusercontent.com/object", "https://user:secret@release-assets.githubusercontent.com/object",
    "https://release-assets.githubusercontent.com:8443/object", "https://api.github.com/repos/o/app/releases/assets/456", "https://[malformed",
  ])("rejects an unsafe redirect target without fetching it", async (target) => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: target } }); };
    await expect(fetchBuildManifest(fetcher, source, { Authorization: `Bearer ${token}` })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it.each(["https://api.github.com/repos/o/app/releases/latest", "https://api.github.com/repos/o/app/releases/assets/123/extra"])("does not follow redirects from a non-asset endpoint", async (endpoint) => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/object" } }); };
    await expect(fetchBuildManifest(fetcher, endpoint, { Authorization: `Bearer ${token}` })).rejects.toThrow("redirect was rejected");
    expect(calls).toBe(1);
  });

  it("bounds redirect hops and keeps signed locations out of errors", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => new Response(null, { status: 302, headers: { Location: `https://release-assets.githubusercontent.com/object${++calls}?signature=private` } });
    let error: unknown;
    try { await fetchBuildManifest(fetcher, source, { Authorization: `Bearer ${token}` }); } catch (caught) { error = caught; }
    expect(calls).toBe(4);
    expect(String(error)).not.toContain("signature");
    expect(String(error)).not.toContain(token);
  });

  it("does not send supplied credentials to an initial non-API manifest URL", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect([...new Headers(init?.headers).keys()].sort()).toEqual(["accept", "user-agent"]);
      return new Response("{}");
    };
    await fetchBuildManifest(fetcher, "https://release-assets.githubusercontent.com/object", { Authorization: `Bearer ${token}`, Cookie: "private", "X-Token": "private" });
  });
});
