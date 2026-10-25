import { beforeEach, describe, expect, it } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { saveSecrets } from "../src/secrets.js";
import { requestBuild } from "../src/testflight.js";
import { handle } from "../src/index.js";
import { GH_TOKEN, api, applePem, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, manifest, signIn, testDeps, testEnv, type Call, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let app: AppRow;
let cookie: string;
let buildToken: string;
const repository = "GET api.github.com/repos/o/skull";
const workflow = `${repository}/actions/workflows/apple-testflight.yml`;
const dispatch = "POST api.github.com/repos/o/skull/actions/workflows/apple-testflight.yml/dispatches";
const appleBuilds = "GET api.appstoreconnect.apple.com/v1/builds";

function applePage(numbers: string[], platform = "MAC_OS", version = manifest.version, next: string | null = null) {
  return { data: numbers.map((number, index) => ({ type: "builds", id: `build-${index}`, attributes: { version: number }, relationships: { app: { data: { type: "apps", id: "asc" } }, preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre" } } } })),
    included: [{ type: "preReleaseVersions", id: "pre", attributes: { version, platform } }], links: { next } };
}

function platformRoutes() {
  return { ...githubRoutes(),
    [repository]: () => jsonRes({ default_branch: "shipping/apple" }),
    [workflow]: () => jsonRes({ state: "active", name: "apple-platform-testflight" }),
    [`${workflow}/runs`]: () => jsonRes({ workflow_runs: [{ run_number: 37 }] }),
    [dispatch]: () => new Response(null, { status: 204 }),
    [appleBuilds]: (call: Call) => {
      const params = new URL(call.url).searchParams;
      return jsonRes(applePage([], params.get("filter[preReleaseVersion.platform]")!, params.get("filter[preReleaseVersion.version]")!));
    },
  };
}

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
  const created = await createSkull(env, deps, cookie);
  buildToken = created.buildToken;
  app = (await Db.from(env).appById(created.appId))!;
  await saveSecrets(env, app.developerId, { githubToken: GH_TOKEN, appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: await applePem() }, deps.now());
  for (const platform of ["macos", "tvos"] as const) {
    const target = await Db.from(env).platformApp(app, platform);
    target.ascAppId = "asc";
    await Db.from(env).setAppTestflight(target);
  }
});

describe("build-token build-number reservation", () => {
  const path = (id: string, platform = "macos") => `/api/build/${id}/${platform}/testflight/reserve-build`;
  const headers = () => ({ Authorization: `Bearer ${buildToken}` });

  it.each(["macos", "tvos"])("returns only string version/buildNumber for %s without dispatching", async (platform) => {
    const github = fakeFetch(platformRoutes());
    const response = await handle(api(null, "POST", path(app.id, platform), undefined, headers()), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json();
    expect(result).toEqual({ version: manifest.version, buildNumber: "1" });
    expect(Object.keys(result as object).sort()).toEqual(["buildNumber", "version"]);
    expect(JSON.stringify(result)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(result)).not.toContain(buildToken);
    expect(github.calls.some((call) => call.method !== "GET")).toBe(false);
    expect(github.calls.some((call) => call.url.includes("/actions/"))).toBe(false);
    expect((await Db.from(env).platformApp(app, platform as "macos" | "tvos")).buildRequestedAt).toBeNull();
  });

  it.each([undefined, "invalid"])("rejects missing or invalid build token %s", async (token) => {
    const github = fakeFetch(platformRoutes());
    const response = await handle(api(null, "POST", path(app.id), undefined, token ? { Authorization: `Bearer ${token}` } : {}), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(401);
    expect(github.calls).toHaveLength(0);
  });

  it("rejects a token belonging to another app", async () => {
    const other = await createSkull(env, deps, cookie);
    const github = fakeFetch(platformRoutes());
    const response = await handle(api(null, "POST", path(app.id), undefined, { Authorization: `Bearer ${other.buildToken}` }), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(401);
    expect(github.calls).toHaveLength(0);
  });

  it.each(["ios", "unknown"])("rejects unsupported platform %s", async (platform) => {
    const github = fakeFetch(platformRoutes());
    const response = await handle(api(null, "POST", path(app.id, platform), undefined, headers()), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(400);
    if (platform === "ios") expect(await response.json()).toEqual({ error: "Build-number reservation supports macos and tvos only; ios reservation is unsupported." });
    expect(github.calls).toHaveLength(0);
  });

  it("returns 409 when the target platform is not set up", async () => {
    const target = await Db.from(env).platformApp(app, "macos");
    target.ascAppId = null;
    await Db.from(env).setAppTestflight(target);
    const github = fakeFetch(platformRoutes());
    const response = await handle(api(null, "POST", path(app.id), undefined, headers()), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Set up TestFlight for this platform before reserving a build number." });
    expect(github.calls).toHaveLength(0);
  });

  it("returns a sanitized 502 without allocating when Apple reconciliation fails", async () => {
    const github = fakeFetch({ ...platformRoutes(), [appleBuilds]: () => new Response(GH_TOKEN, { status: 403 }) });
    const response = await handle(api(null, "POST", path(app.id), undefined, headers()), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(502);
    const result = await response.text();
    expect(result).toContain("Could not verify all existing Apple build numbers");
    expect(result).not.toContain(GH_TOKEN);
    expect(github.calls.some((call) => call.method !== "GET")).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it("shares the atomic allocator with simultaneous dashboard POSTs", async () => {
    const github = fakeFetch(platformRoutes());
    const d = { ...deps, fetch: github.fetch };
    const [reserved, dashboard] = await Promise.all([
      handle(api(null, "POST", path(app.id), undefined, headers()), env, d),
      handle(api(cookie, "POST", `/api/dev/apps/${app.id}/testflight/macos/build`), env, d),
    ]);
    expect(reserved.status).toBe(200);
    expect(dashboard.status).toBe(200);
    const result = await reserved.json() as { version: string; buildNumber: string };
    const sent = github.calls.filter((call) => call.method === "POST");
    expect(sent).toHaveLength(1);
    const dispatched = JSON.parse(sent[0]!.body!).inputs;
    expect([result.buildNumber, dispatched.build].sort()).toEqual(["1", "2"]);
    expect(result.version).toBe(dispatched.version);
    expect(await env.DB.prepare("SELECT counter FROM build_number_reservations WHERE app_id = ? AND platform = 'macos'").bind(app.id).first()).toEqual({ counter: 2 });
  });

  it("reserves using the safely redirected private release manifest", async () => {
    const github = fakeFetch({ ...platformRoutes(),
      "GET api.github.com/repos/o/skull/releases/assets/1": () => new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/object?signature=private" } }),
      "GET release-assets.githubusercontent.com/object": (call) => {
        expect([...call.headers.keys()].sort()).toEqual(["accept", "user-agent"]);
        return jsonRes({ ...manifest, version: "3.2.1" });
      },
    });
    const response = await handle(api(null, "POST", path(app.id), undefined, headers()), env, { ...deps, fetch: github.fetch });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "3.2.1", buildNumber: "1" });
    expect(github.calls.some((call) => call.method !== "GET")).toBe(false);
  });
});

async function upload(platform: "ios" | "macos" | "tvos", buildNumber: string, version = manifest.version) {
  await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version, buildNumber, uploadId: null, uploadFileId: null, buildId: null, whatsNew: null, state: "uploaded", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
}

describe("platform build requests", () => {
  it.each(["macos", "tvos"] as const)("dispatches %s with validated version, default branch and a greater platform build number", async (platform) => {
    await upload(platform, "80");
    await upload(platform, "4");
    await upload(platform === "macos" ? "tvos" : "macos", "999");
    const target = await Db.from(env).platformApp(app, platform);
    const github = fakeFetch(platformRoutes());
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "testflight-set-up");
    expect(target).toMatchObject({ buildRequestedAt: deps.now().toISOString(), buildRequestError: null });
    expect(await Db.from(env).platformApp(app, platform)).toMatchObject({ buildRequestedAt: deps.now().toISOString(), buildRequestError: null });
    const sent = github.calls.filter((call) => call.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.github.com/repos/o/skull/actions/workflows/apple-testflight.yml/dispatches");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ ref: "shipping/apple", inputs: { platform, version: manifest.version, build: "81", upload: "true" } });
    expect(github.calls.some((call) => call.url.includes("/runs?"))).toBe(false);
    const filters = new URL(github.calls.find((call) => call.url.includes("/v1/builds?"))!.url).searchParams;
    expect(filters.get("filter[app]")).toBe("asc");
    expect(filters.get("filter[preReleaseVersion.version]")).toBe(manifest.version);
    expect(filters.get("filter[preReleaseVersion.platform]")).toBe(platform === "macos" ? "MAC_OS" : "TV_OS");
    expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${GH_TOKEN}`);
    expect(github.calls.filter((call) => call.url.endsWith("/releases/latest") || call.url.endsWith("/assets/1")).every((call) => call.headers.get("Authorization") === `Bearer ${GH_TOKEN}`)).toBe(true);
    expect(JSON.stringify({ body: JSON.parse(sent[0]!.body!), error: target.buildRequestError })).not.toContain(GH_TOKEN);
    expect((await Db.from(env).appById(app.id))!.buildRequestedAt).toBeNull();
  });

  it("starts at one when no uploaded or reserved builds exist, independently of workflow run_number", async () => {
    const github = fakeFetch(platformRoutes());
    await requestBuild(env, { ...deps, fetch: github.fetch }, await Db.from(env).platformApp(app, "macos"), "requested");
    expect(JSON.parse(github.calls.find((call) => call.method === "POST")!.body!).inputs.build).toBe("1");
  });

  it("reports a missing published workflow without dispatching any release", async () => {
    const github = fakeFetch({ ...platformRoutes(), [workflow]: () => new Response(GH_TOKEN, { status: 404 }) });
    const target = await Db.from(env).platformApp(app, "tvos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("Publish .github/workflows/apple-testflight.yml");
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
    expect(await Db.from(env).platformApp(app, "tvos")).toMatchObject({ buildRequestedAt: deps.now().toISOString(), buildRequestError: target.buildRequestError });
  });

  it.each([401, 403])("records actionable Actions: write guidance on dispatch status %s", async (status) => {
    const github = fakeFetch({ ...platformRoutes(), [dispatch]: () => new Response(GH_TOKEN, { status }) });
    const target = await Db.from(env).platformApp(app, "macos");
    await expect(requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested")).resolves.toBeUndefined();
    expect(target.buildRequestError).toContain("Actions: write");
    expect(target.buildRequestError).toContain("account settings");
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("reports Actions: read access errors without sending a dispatch", async () => {
    const github = fakeFetch({ ...platformRoutes(), [workflow]: () => new Response(GH_TOKEN, { status: 403 }) });
    const target = await Db.from(env).platformApp(app, "tvos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("Actions: read");
    expect(target.buildRequestError).toContain("Actions: write");
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it.each([undefined, "invalid-manifest", "default-branch-missing", "disabled-workflow"])("does not dispatch when %s blocks the platform request", async (blocked) => {
    const routes = platformRoutes();
    if (blocked === undefined) await saveSecrets(env, app.developerId, {}, deps.now());
    if (blocked === "invalid-manifest") Object.assign(routes, { "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes({ version: "1.2.3" }) });
    if (blocked === "default-branch-missing") routes[repository] = () => jsonRes({});
    if (blocked === "disabled-workflow") routes[workflow] = () => jsonRes({ state: "disabled_manually" });
    const github = fakeFetch(routes);
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toBeTruthy();
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("keeps legacy iOS repository dispatch unchanged", async () => {
    const github = fakeFetch(githubRoutes());
    await requestBuild(env, { ...deps, fetch: github.fetch }, app, "requested");
    expect(app.buildRequestError).toBeNull();
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]!.url).toBe("https://api.github.com/repos/o/skull/dispatches");
    expect(JSON.parse(github.calls[0]!.body!)).toEqual({ event_type: "my-store-release", client_payload: { app: app.id, reason: "requested" } });
    expect((await Db.from(env).appById(app.id))!.buildRequestedAt).toBe(deps.now().toISOString());
  });

  it("rejects a redirected iOS repository dispatch without forwarding credentials", async () => {
    const github = fakeFetch({ ...githubRoutes(), "POST api.github.com/repos/o/skull/dispatches": () => new Response(null, { status: 307, headers: { Location: "https://other.invalid/credentials" } }) });
    await requestBuild(env, { ...deps, fetch: (input, init) => {
      expect(init?.redirect).toBe("manual");
      return github.fetch(input, init);
    } }, app, "requested");
    expect(app.buildRequestError).toContain("redirected");
    expect(github.calls).toHaveLength(1);
  });

  it("blocks requests without saved Apple credentials", async () => {
    await saveSecrets(env, app.developerId, { githubToken: GH_TOKEN }, deps.now());
    const github = fakeFetch(platformRoutes());
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("saved App Store Connect key");
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("atomically allocates distinct inputs to simultaneous requests", async () => {
    const github = fakeFetch(platformRoutes());
    const targets = await Promise.all([Db.from(env).platformApp(app, "macos"), Db.from(env).platformApp(app, "macos")]);
    await Promise.all(targets.map((target) => requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested")));
    expect(targets.map((target) => target.buildRequestError)).toEqual([null, null]);
    expect(github.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!).inputs.build).sort()).toEqual(["1", "2"]);
    expect(await env.DB.prepare("SELECT counter FROM build_number_reservations WHERE app_id = ? AND platform = 'macos'").bind(app.id).first()).toEqual({ counter: 2 });
  });

  it("consumes a reservation on failed dispatch and allocates a fresh number on retry", async () => {
    let attempt = 0;
    const github = fakeFetch({ ...platformRoutes(), [dispatch]: () => ++attempt === 1 ? new Response("denied", { status: 403 }) : new Response(null, { status: 204 }) });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("Actions: write");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toBeNull();
    expect(github.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!).inputs.build)).toEqual(["1", "2"]);
  });

  it("reconciles untracked Apple uploads and verifies every page", async () => {
    await upload("macos", "80");
    let page = 0;
    const github = fakeFetch({ ...platformRoutes(), [appleBuilds]: () => jsonRes(++page === 1
      ? applePage(["000101"], "MAC_OS", manifest.version, "https://api.appstoreconnect.apple.com/v1/builds?cursor=page2")
      : applePage(["1500"])) });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toBeNull();
    expect(page).toBe(2);
    expect(JSON.parse(github.calls.find((call) => call.method === "POST")!.body!).inputs.build).toBe("1501");
  });

  it("isolates platform and version counters and includes pending reservations", async () => {
    const db = Db.from(env);
    await upload("macos", "80");
    await upload("macos", "900", "2.0.0");
    expect(await db.reserveBuildNumber(app.id, "macos", manifest.version, 100)).toBe(101);
    expect(await db.reserveBuildNumber(app.id, "tvos", manifest.version, 0)).toBe(1);
    expect(await db.reserveBuildNumber(app.id, "macos", "2.0.0", 0)).toBe(901);
    expect(await db.reserveBuildNumber(app.id, "macos", manifest.version, 50)).toBe(102);
    expect(await db.reserveBuildNumber(app.id, "macos", "3.0.0", 0)).toBe(1);
  });

  it.each(["permission", "unavailable", "pages", "foreign-link", "wrong-platform", "wrong-version", "incomplete"])("blocks dispatch when Apple lookup is %s", async (failure) => {
    let page = 0;
    const github = fakeFetch({ ...platformRoutes(), [appleBuilds]: () => {
      page++;
      if (failure === "permission" || failure === "unavailable") return new Response(GH_TOKEN, { status: failure === "permission" ? 403 : 500 });
      if (failure === "pages") return jsonRes(applePage([], "MAC_OS", manifest.version, `https://api.appstoreconnect.apple.com/v1/builds?cursor=${page}`));
      if (failure === "foreign-link") return jsonRes(applePage([], "MAC_OS", manifest.version, "https://other.invalid/v1/builds"));
      if (failure === "wrong-platform") return jsonRes(applePage(["500"], "TV_OS"));
      if (failure === "wrong-version") return jsonRes(applePage(["500"], "MAC_OS", "8.0.0"));
      return jsonRes({ ...applePage([]), meta: { paging: { total: 1 } } });
    } });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("Could not verify all existing Apple build numbers");
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
    expect(page).toBeLessThanOrEqual(10);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it.each(["12.3", "-1", "1e3", "9007199254740992"])("blocks unsafe or non-integer Apple build number %s", async (number) => {
    const github = fakeFetch({ ...platformRoutes(), [appleBuilds]: () => jsonRes(applePage([number])) });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("build number");
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects invalid local builds and exhausted pending counters", async () => {
    await upload("macos", "1.2");
    await expect(Db.from(env).reserveBuildNumber(app.id, "macos", manifest.version, 0)).rejects.toThrow("not an integer");
    expect(await Db.from(env).reserveBuildNumber(app.id, "tvos", manifest.version, Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    await expect(Db.from(env).reserveBuildNumber(app.id, "tvos", manifest.version, 0)).rejects.toThrow("range is exhausted");
    await expect(Db.from(env).reserveBuildNumber(app.id, "macos", "4.0.0", Number.MAX_SAFE_INTEGER)).rejects.toThrow("range is exhausted");
  });

  it.each([repository, workflow, dispatch, "GET api.github.com/repos/o/skull/releases/latest", appleBuilds])("rejects redirects at %s without forwarding credentials", async (endpoint) => {
    const github = fakeFetch({ ...platformRoutes(), [endpoint]: () => new Response(null, { status: 302, headers: { Location: "https://other.invalid/credential-trap" } }) });
    const redirects: RequestInit["redirect"][] = [];
    const guardedFetch: typeof fetch = (input, init) => {
      redirects.push(init?.redirect);
      return github.fetch(input, init);
    };
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: guardedFetch }, target, "requested");
    expect(target.buildRequestError).toBeTruthy();
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    if (endpoint !== appleBuilds) expect(target.buildRequestError).toContain("redirect");
    expect(redirects.every((mode) => mode === "manual")).toBe(true);
    expect(github.calls.some((call) => call.url.includes("other.invalid"))).toBe(false);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(endpoint === dispatch ? 1 : 0);
  });

  it("loads a private release manifest through a credential-free asset redirect", async () => {
    const github = fakeFetch({ ...platformRoutes(),
      "GET api.github.com/repos/o/skull/releases/assets/1": () => new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/object?signature=private" } }),
      "GET release-assets.githubusercontent.com/object": (call) => {
        expect(call.headers.get("Authorization")).toBeNull();
        expect(call.headers.get("Cookie")).toBeNull();
        return jsonRes({ ...manifest, version: "3.2.1" });
      },
    });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toBeNull();
    expect(github.calls.find((call) => call.url.endsWith("/assets/1"))!.headers.get("Authorization")).toBe(`Bearer ${GH_TOKEN}`);
    expect(JSON.parse(github.calls.find((call) => call.method === "POST")!.body!).inputs.version).toBe("3.2.1");
  });

  it.each(["wrong-host", "http", "downgrade"])("blocks native dispatch on an asset redirect with %s", async (failure) => {
    const destination = failure === "wrong-host" ? "https://other.invalid/object" : failure === "http" ? "http://release-assets.githubusercontent.com/object" : "https://release-assets.githubusercontent.com/object";
    const github = fakeFetch({ ...platformRoutes(),
      "GET api.github.com/repos/o/skull/releases/assets/1": () => new Response(null, { status: 302, headers: { Location: destination } }),
      "GET release-assets.githubusercontent.com/object": (call) => {
        expect(call.headers.get("Authorization")).toBeNull();
        return new Response(null, { status: 302, headers: { Location: "http://objects.githubusercontent.com/object" } });
      },
    });
    const target = await Db.from(env).platformApp(app, "macos");
    await requestBuild(env, { ...deps, fetch: github.fetch }, target, "requested");
    expect(target.buildRequestError).toContain("redirect was rejected");
    expect(target.buildRequestError).not.toContain(GH_TOKEN);
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
    expect(github.calls.some((call) => new URL(call.url).protocol !== "https:")).toBe(false);
    expect(github.calls.some((call) => new URL(call.url).hostname === "other.invalid")).toBe(false);
  });
});
