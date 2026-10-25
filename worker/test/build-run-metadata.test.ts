import { beforeEach, describe, expect, it } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { loadBuildStatus } from "../src/github.js";
import { handle } from "../src/index.js";
import { saveSecrets } from "../src/secrets.js";
import { GH_TOKEN, api, applePem, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, manifest, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let app: AppRow;
let buildToken: string;
const action = "GET api.github.com/repos/o/skull/actions/";
const workflow = { id: 22, path: ".github/workflows/apple-testflight.yml", name: "apple-platform-testflight", state: "active" };

function routes(overrides: Record<string, unknown> = {}, workflowOverrides = {}) {
  const run = { id: 101, workflow_id: 22, run_attempt: 1, run_number: 37, status: "completed", conclusion: "success", repository: { full_name: "o/skull" }, display_title: "Apple TestFlight macos pending", event: "workflow_dispatch", created_at: "2026-10-16T09:58:00Z", run_started_at: "2026-10-16T09:59:00Z", html_url: "https://github.com/o/skull/actions/runs/101", ...overrides };
  return { ...githubRoutes(),
    [`${action}runs/101/attempts/1`]: () => jsonRes({ ...run }),
    [`${action}runs/101/attempts/2`]: () => jsonRes({ ...run, run_attempt: 2, ...overrides }),
    [`${action}workflows/22`]: () => jsonRes({ ...workflow, ...workflowOverrides }),
    [`${action}workflows`]: () => jsonRes({ workflows: [workflow] }),
    [`${action}workflows/22/runs`]: () => jsonRes({ workflow_runs: [run] }),
    "GET api.appstoreconnect.apple.com/v1/builds": () => jsonRes({ data: [], links: { next: null } }),
  };
}

function reserve(metadata?: unknown) {
  return api(null, "POST", `/api/build/${app.id}/macos/testflight/reserve-build`, metadata, { Authorization: `Bearer ${buildToken}` });
}

async function upload(version: string, buildNumber: string, platform: "macos" | "tvos" = "macos", createdAt = deps.now().toISOString(), appId = app.id) {
  await Db.from(env).insertTestflightBuild({ appId, platform, version, buildNumber, uploadId: null, uploadFileId: null, buildId: null, whatsNew: null, state: "uploaded", message: null, createdAt, updatedAt: createdAt });
}

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  const cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  buildToken = made.buildToken;
  app = (await Db.from(env).platformApp((await Db.from(env).appById(made.appId))!, "macos"));
  app.ascAppId = "asc";
  await Db.from(env).setAppTestflight(app);
  await saveSecrets(env, app.developerId, { githubToken: GH_TOKEN, appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: await applePem() }, deps.now());
});

describe("verified reservation metadata", () => {
  it.each([{ runId: "101", runAttempt: "1" }, { runId: 101, runAttempt: 1 }, { runId: "00101", runAttempt: "01" }])("verifies and stores safe metadata %j without changing the response", async (metadata) => {
    const github = fakeFetch(routes());
    const response = await handle(reserve(metadata), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: manifest.version, buildNumber: "1" });
    expect(await Db.from(env).buildRunReservation(app.id, "macos", app.repo, { runId: "101", runAttempt: "1" })).toMatchObject({ version: manifest.version, buildNumber: "1", runId: "101", runAttempt: "1", repo: "o/skull" });
    expect(github.calls.every((call) => call.method === "GET")).toBe(true);
    expect(github.calls.filter((call) => call.url.includes("/actions/")).every((call) => call.headers.get("Authorization") === `Bearer ${GH_TOKEN}`)).toBe(true);
  });

  it.each([false, null, [], { runId: "101" }, { runAttempt: "1" }, { runId: false, runAttempt: "1" }, { runId: "0", runAttempt: "1" }, { runId: "101", runAttempt: -1 }, { runId: "101", runAttempt: 1.5 }, { runId: "9007199254740992", runAttempt: "1" }, { runId: "101", runAttempt: "1e1" }])("rejects malformed metadata %j before allocating", async (metadata) => {
    const github = fakeFetch(routes());
    const response = await handle(reserve(metadata), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(400);
    expect(github.calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it.each([
    ["repository", { repository: { full_name: "other/repo" } }, {}, 400],
    ["run", { id: 202 }, {}, 400],
    ["workflow", {}, { path: ".github/workflows/release.yml" }, 400],
    ["platform", { display_title: "Apple TestFlight tvos pending" }, {}, 400],
    ["title", { display_title: "apple-platform-testflight" }, {}, 400],
    ["attempt", { run_attempt: 2 }, {}, 409],
  ])("rejects wrong %s identity without allocating", async (_name, runOverrides, workflowOverrides, expected) => {
    const github = fakeFetch(routes(runOverrides as Record<string, unknown>, workflowOverrides));
    const response = await handle(reserve({ runId: "101", runAttempt: "1" }), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain(GH_TOKEN);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_run_reservations").first()).toEqual({ count: 0 });
  });

  it.each([401, 403, 404, 500, 302])("handles verification response %s without allocating or exposing upstream details", async (status) => {
    const github = fakeFetch({ ...routes(), [`${action}runs/101/attempts/1`]: () => new Response(GH_TOKEN, { status, headers: { Location: "https://other.invalid/secret" } }) });
    const response = await handle(reserve({ runId: "101", runAttempt: "1" }), env, { ...deps, fetch: (input, init) => {
      expect(init?.redirect).toBe("manual");
      return github.fetch(input, init);
    } });
    expect(response.status).toBe(status === 404 ? 409 : 502);
    const message = await response.text();
    expect(message).not.toContain(GH_TOKEN);
    expect(message).not.toContain("other.invalid");
    if (status === 401 || status === 403) expect(message).toContain("Actions: read");
    expect(github.calls).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it("revalidates retries, returns the original pair and isolates different attempts", async () => {
    const github = fakeFetch(routes());
    const d = { ...deps, fetch: github.fetch };
    const first = await handle(reserve({ runId: "101", runAttempt: "1" }), env, d);
    expect(await first.json()).toEqual({ version: manifest.version, buildNumber: "1" });
    const retry = await handle(reserve({ runId: "101", runAttempt: "1" }), env, d);
    expect(await retry.json()).toEqual({ version: manifest.version, buildNumber: "1" });
    const next = await handle(reserve({ runId: "101", runAttempt: "2" }), env, d);
    expect(await next.json()).toEqual({ version: manifest.version, buildNumber: "2" });
    expect(github.calls.filter((call) => call.url.endsWith("/attempts/1"))).toHaveLength(2);
    expect(await env.DB.prepare("SELECT counter FROM build_number_reservations").first()).toEqual({ counter: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_run_reservations").first()).toEqual({ count: 2 });
    const invalid = fakeFetch(routes({ repository: { full_name: "other/repo" } }));
    expect((await handle(reserve({ runId: "101", runAttempt: "1" }), env, { ...deps, fetch: invalid.fetch })).status).toBe(400);
    expect(await env.DB.prepare("SELECT counter FROM build_number_reservations").first()).toEqual({ counter: 2 });
  });

  it("returns one canonical pair to concurrent requests for the same attempt", async () => {
    const github = fakeFetch(routes());
    const responses = await Promise.all([1, 2, 3].map(() => handle(reserve({ runId: "101", runAttempt: "1" }), env, { ...deps, fetch: github.fetch })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const pairs = await Promise.all(responses.map((response) => response.json()));
    expect(pairs[0]).toEqual(pairs[1]);
    expect(pairs[1]).toEqual(pairs[2]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_run_reservations").first()).toEqual({ count: 1 });
    const next = await handle(reserve(), env, { ...deps, fetch: github.fetch });
    expect(await next.json()).not.toEqual(pairs[0]);
  });

  it.each([undefined, {}])("keeps bodyless and empty metadata requests independent without association", async (metadata) => {
    const github = fakeFetch(routes());
    const first = await handle(reserve(metadata), env, { ...deps, fetch: github.fetch });
    const next = await handle(reserve(metadata), env, { ...deps, fetch: github.fetch });
    expect(await first.json()).toEqual({ version: manifest.version, buildNumber: "1" });
    expect(await next.json()).toEqual({ version: manifest.version, buildNumber: "2" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_run_reservations").first()).toEqual({ count: 0 });
  });
});

describe("reservation upload status", () => {
  it("keeps a pending version unknown even when the title contains a numeric build", async () => {
    const github = fakeFetch(routes({ display_title: "Apple TestFlight macos pending (1)" }));
    expect(await loadBuildStatus(env, { ...deps, fetch: github.fetch }, app, GH_TOKEN, [])).toMatchObject({ uploadReceived: null, reason: "workflow-complete-upload-unconfirmed" });
  });

  it("keeps missing pairs unknown and canonical pairs absent until an actual matching upload", async () => {
    await upload("9.9.9", "7");
    const unknown = fakeFetch(routes());
    expect(await loadBuildStatus(env, { ...deps, fetch: unknown.fetch }, app, GH_TOKEN, [])).toMatchObject({ state: "complete", uploadReceived: null, reason: "workflow-complete-upload-unconfirmed", correlation: "platform-title", platformVerified: true });
    deps.advance(15000);
    const canonical = fakeFetch(routes({ display_title: "Apple TestFlight macos 0.1.0 (7)" }));
    expect(await loadBuildStatus(env, { ...deps, fetch: canonical.fetch }, app, GH_TOKEN, [])).toMatchObject({ state: "complete", uploadReceived: false, reason: "workflow-complete-no-upload" });
    await upload("0.1.0", "7");
    deps.advance(15000);
    expect(await loadBuildStatus(env, { ...deps, fetch: canonical.fetch }, app, GH_TOKEN, [])).toMatchObject({ uploadReceived: true, reason: null });
  });

  it("matches only the verified reservation's app, platform, version, build and receipt time", async () => {
    const github = fakeFetch(routes());
    const d = { ...deps, fetch: github.fetch };
    expect((await handle(reserve({ runId: "101", runAttempt: "1" }), env, d)).status).toBe(200);
    await upload(manifest.version, "1", "macos", "2026-10-16T09:59:00Z");
    await upload("9.9.9", "1");
    await upload(manifest.version, "2");
    await upload(manifest.version, "1", "tvos");
    const cookie = await signIn(env, deps);
    const other = await createSkull(env, deps, cookie);
    await upload(manifest.version, "1", "macos", deps.now().toISOString(), other.appId);
    expect(await loadBuildStatus(env, d, app, GH_TOKEN, [])).toMatchObject({ state: "complete", uploadReceived: false, reason: "workflow-complete-no-upload", correlation: "reservation", platformVerified: true });
    await env.DB.prepare("UPDATE testflight_builds SET created_at = ? WHERE app_id = ? AND platform = 'macos' AND version = ? AND build_number = '1'").bind(deps.now().toISOString(), app.id, manifest.version).run();
    deps.advance(15000);
    expect(await loadBuildStatus(env, d, app, GH_TOKEN, [])).toMatchObject({ uploadReceived: true, correlation: "reservation", reason: null });
    deps.advance(15000);
    const rerun = fakeFetch(routes({ run_attempt: 2 }));
    expect(await loadBuildStatus(env, { ...deps, fetch: rerun.fetch }, app, GH_TOKEN, [])).toMatchObject({ runAttempt: 2, uploadReceived: null, correlation: "platform-title", reason: "workflow-complete-upload-unconfirmed" });
  });

  it("does not count an earlier attempt's upload for a later canonical attempt", async () => {
    const github = fakeFetch(routes());
    expect((await handle(reserve({ runId: "101", runAttempt: "1" }), env, { ...deps, fetch: github.fetch })).status).toBe(200);
    await upload(manifest.version, "1");
    deps.advance(6 * 60 * 1000);
    const rerun = fakeFetch(routes({ run_attempt: 2, run_started_at: "2026-10-16T10:05:00Z", display_title: `Apple TestFlight macos ${manifest.version} (1)` }));
    expect(await loadBuildStatus(env, { ...deps, fetch: rerun.fetch }, app, GH_TOKEN, [])).toMatchObject({ runAttempt: 2, uploadReceived: false, correlation: "platform-title", reason: "workflow-complete-no-upload" });
  });
});
