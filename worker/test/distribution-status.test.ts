import { beforeEach, describe, expect, it } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import { sha256Hex } from "../src/crypto.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { saveSecrets } from "../src/secrets.js";
import { api, applePem, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let app: AppRow;
let token: string;
let cookie: string;
const secret = "PRIVATE_DIAGNOSTIC_VALUE";
const groupPath = "GET api.appstoreconnect.apple.com/v1/betaGroups/group";
const testersPath = "GET api.appstoreconnect.apple.com/v1/betaGroups/group/relationships/betaTesters";
const membershipPath = "GET api.appstoreconnect.apple.com/v1/builds/build/betaGroups";
const invitation = "https://testflight.apple.com/join/Example";

function request(bearer = token, platform = "tvos") {
  return api(null, "GET", `/api/build/${app.id}/${platform}/testflight/distribution`, undefined, bearer ? { Authorization: `Bearer ${bearer}` } : {});
}

function routes() {
  return {
    [groupPath]: () => jsonRes({ data: { id: "group", type: "betaGroups", attributes: { publicLinkEnabled: true, isInternalGroup: false, publicLink: invitation, name: secret } } }),
    [testersPath]: () => jsonRes({ data: [], meta: { paging: { total: 0 } } }),
    "GET api.appstoreconnect.apple.com/v1/builds/build/buildBetaDetail": () => jsonRes({ data: { id: "detail", attributes: { externalBuildState: "BETA_APPROVED", autoNotifyEnabled: true, secret } } }),
    [membershipPath]: () => jsonRes({ data: [{ id: "group", type: "betaGroups", attributes: { secret } }] }),
  };
}

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  token = made.buildToken;
  app = (await Db.from(env).appById(made.appId))!;
  await saveSecrets(env, app.developerId, { appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: await applePem() }, deps.now());
  await Db.from(env).setAppTestflight({ ...app, platform: "tvos", ascAppId: "apple-app", betaGroupId: "group", testflightUrl: invitation, testflightLinkState: "open" });
  await Db.from(env).insertTestflightBuild({ appId: app.id, platform: "tvos", version: "0.6.0", buildNumber: "1", buildId: "build", uploadId: "upload", uploadFileId: "file", state: "approved", message: null, whatsNew: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
});

describe("read-only Apple distribution status", () => {
  it("reads actual group membership, tester count and notification settings without writes or secrets", async () => {
    const db = Db.from(env);
    const before = await db.testflightBuilds(app.id, 6, "tvos");
    const blob = await db.secretsBlob(app.developerId);
    const hash = (await db.appById(app.id))!.buildTokenHash;
    const stub = fakeFetch(routes());
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
    expect(text).not.toContain(invitation);
    expect(JSON.parse(text)).toMatchObject({ platform: "tvos", status: "complete", errors: [], group: { id: "group", publicLinkEnabled: true, publicLinkMatchesConfigured: true, isInternalGroup: false, testerCount: 0 }, builds: [{ version: "0.6.0", buildNumber: "1", recordedState: "approved", externalBuildState: "BETA_APPROVED", autoNotifyEnabled: true, inConfiguredGroup: true }] });
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls.every(call => call.method === "GET")).toBe(true);
    expect(await db.testflightBuilds(app.id, 6, "tvos")).toEqual(before);
    expect(await db.secretsBlob(app.developerId)).toBe(blob);
    expect((await db.appById(app.id))!.buildTokenHash).toBe(hash);
  });

  it.each(["", "wrong"])("rejects invalid authentication %j before Apple reads", async bearer => {
    const stub = fakeFetch({});
    expect((await handle(request(bearer), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects another app's build token", async () => {
    const other = await createSkull(env, deps, cookie);
    const stub = fakeFetch({});
    expect((await handle(request(other.buildToken), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("requires platform setup and rejects unsupported platforms", async () => {
    const stub = fakeFetch({});
    expect((await handle(request(token, "macos"), env, { ...deps, fetch: stub.fetch })).status).toBe(409);
    expect((await handle(request(token, "unknown"), env, { ...deps, fetch: stub.fetch })).status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it("remains available when the target is disabled", async () => {
    await Db.from(env).setAppTarget(app.id, "tvos", false);
    const stub = fakeFetch(routes());
    expect((await handle(request(), env, { ...deps, fetch: stub.fetch })).status).toBe(200);
    expect((await Db.from(env).appTargets(app.id)).tvos).toBe(false);
  });

  it("does not rewrite legacy hashes or rotated credentials", async () => {
    const db = Db.from(env);
    const legacy = await sha256Hex(token);
    await env.DB.prepare("UPDATE apps SET build_token_hash = ? WHERE id = ?").bind(legacy, app.id).run();
    const blob = await db.secretsBlob(app.developerId);
    const rotated = { ...env, MASTER_KEY: "new-test-key", MASTER_KEY_PREVIOUS: env.MASTER_KEY };
    const stub = fakeFetch(routes());
    expect((await handle(request(), rotated, { ...deps, fetch: stub.fetch })).status).toBe(200);
    expect((await db.appById(app.id))!.buildTokenHash).toBe(legacy);
    expect(await db.secretsBlob(app.developerId)).toBe(blob);
  });

  it("reports incomplete membership and counts as unknown rather than absent", async () => {
    const stub = fakeFetch({ ...routes(),
      [membershipPath]: () => jsonRes({ data: [], links: { next: "https://api.appstoreconnect.apple.com/next" } }),
      [testersPath]: () => jsonRes({ data: [{ id: secret, type: "betaTesters" }], links: { next: "https://api.appstoreconnect.apple.com/next" } }),
    });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ group: { testerCount: null }, builds: [{ inConfiguredGroup: null }] });
  });

  it("reports absent membership and a nonzero tester total precisely", async () => {
    const stub = fakeFetch({ ...routes(),
      [membershipPath]: () => jsonRes({ data: [{ id: "other-group", type: "betaGroups" }] }),
      [testersPath]: () => jsonRes({ data: [{ id: secret, type: "betaTesters" }], meta: { paging: { total: 42 } } }),
    });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(await response.json()).toMatchObject({ group: { testerCount: 42 }, builds: [{ inConfiguredGroup: false }] });
  });

  it.each([302, 401, 403, 404, 500])("sanitises Apple error %s", async status => {
    const stub = fakeFetch({ ...routes(), [groupPath]: () => jsonRes({ errors: [{ detail: secret }] }, status) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ status: "partial", errors: [{ operation: "group", buildId: null, appleStatus: status }], group: { publicLinkEnabled: null }, builds: [{ externalBuildState: "BETA_APPROVED", inConfiguredGroup: true }] });
    expect(stub.calls).toHaveLength(4);
  });

  it("rejects a mismatched group response", async () => {
    const stub = fakeFetch({ ...routes(), [groupPath]: () => jsonRes({ data: { id: secret, type: "betaGroups", attributes: {} } }) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ status: "partial", errors: [{ operation: "group", buildId: null, appleStatus: 502 }] });
  });

  it.each([
    [testersPath, "tester-count", null],
    ["GET api.appstoreconnect.apple.com/v1/builds/build/buildBetaDetail", "build-detail", "build"],
    [membershipPath, "build-groups", "build"],
  ])("identifies a denied %s operation without discarding independent evidence", async (path, operation, buildId) => {
    const stub = fakeFetch({ ...routes(), [path!]: () => jsonRes({ errors: [{ detail: secret }] }, 403) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    const data = JSON.parse(text);
    expect(data).toMatchObject({ status: "partial", errors: [{ operation, buildId, appleStatus: 403 }], group: { publicLinkEnabled: true } });
    if (operation === "tester-count") expect(data).toMatchObject({ group: { testerCount: null }, builds: [{ inConfiguredGroup: true, autoNotifyEnabled: true }] });
    if (operation === "build-detail") expect(data.builds[0]).toMatchObject({ externalBuildState: null, autoNotifyEnabled: null, inConfiguredGroup: true });
    if (operation === "build-groups") expect(data.builds[0]).toMatchObject({ externalBuildState: "BETA_APPROVED", inConfiguredGroup: null });
    expect(stub.calls.every(call => call.method === "GET")).toBe(true);
  });
});
