import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { appleClient } from "../src/flow.js";
import { handle } from "../src/index.js";
import { saveSecrets } from "../src/secrets.js";
import { ensureInstallerSigning, renewStoreProfile, requestBuild, tickTestflight } from "../src/testflight.js";
import { requireTarget, TargetDisabledError } from "../src/targets.js";
import { CSR, api, apple, applePem, appleRoutes, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, rsaPem, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let cookie: string;
let app: AppRow;
let token: string;
let privateKey: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  token = made.buildToken;
  app = (await Db.from(env).appById(made.appId))!;
  app.bundleId = "com.example.skull";
  await Db.from(env).updateApp(app);
  privateKey = await applePem();
  await saveSecrets(env, app.developerId, { appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: privateKey, githubToken: "github-private-token", signingKey: "private-signing-key", installerSigningKey: "installer-private-key" }, deps.now());
  for (const installer of [false, true]) await Db.from(env).putSigningCertificate({ developerId: app.developerId, certificateId: "cert", name: "Distribution", serialNumber: "serial", certificateBase64: "certificate", expirationDate: "2099-01-01T00:00:00Z", createdAt: deps.now().toISOString() }, installer);
  for (const platform of ["ios", "macos", "tvos"] as const) {
    const target = await Db.from(env).platformApp(app, platform);
    Object.assign(target, { ascAppId: "asc", betaGroupId: "group", storeProfileName: "Skull App Store", storeProfileBase64: "profile", storeProfileUuid: "uuid", testflightUrl: "https://testflight.apple.com/join/TEST" });
    await Db.from(env).setAppTestflight(target);
  }
  app = (await Db.from(env).appById(app.id))!;
});

afterEach(() => vi.restoreAllMocks());

const headers = () => ({ Authorization: `Bearer ${token}` });
const route = (platform: string, step: string) => `/api/build/${app.id}/${platform}/testflight/${step}`;
const uploadBody = (platform: string) => ({ version: "1.0", buildNumber: "7", fileName: platform === "macos" ? "app.pkg" : "app.ipa", fileSize: 10 });
const client = (d: TestDeps = deps) => appleClient(env, d, { appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: privateKey });

async function disabled(response: Response) {
  expect(response.status).toBe(409);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Target is disabled." });
}

describe("disabled target work", () => {
  it.each(["ios", "macos", "tvos"] as const)("blocks %s mutation/capability routes while preserving status", async (platform) => {
    await Db.from(env).setAppTarget(app.id, platform, false);
    const stub = fakeFetch({});
    const d = { ...deps, fetch: stub.fetch };
    const paths: [string, string, unknown?][] = [
      ["GET", `/api/build/${app.id}/${platform}/signing`], ["HEAD", `/api/build/${app.id}/${platform}/signing`],
      ["POST", route(platform, "upload"), uploadBody(platform)], ["POST", route(platform, "commit"), {}],
      ["POST", route(platform, "upload/file/operations"), {}],
    ];
    if (platform !== "ios") paths.push(["POST", route(platform, "reserve-build")]);
    else paths.push(["GET", `/api/build/${app.id}/signing`], ["HEAD", `/api/build/${app.id}/signing`], ["POST", `/api/build/${app.id}/testflight/upload`, {}], ["POST", `/api/build/${app.id}/testflight/commit`, {}]);
    for (const [method, path, body] of paths) await disabled(await handle(api(null, method, path, body, headers()), env, d));
    for (const suffix of ["", "/build"]) await disabled(await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/testflight/${platform}${suffix}`, { repair: true }), env, d));
    expect(stub.calls).toHaveLength(0);
    expect((await handle(api(cookie, "GET", `/api/dev/apps/${app.id}/testflight/${platform}`), env, d)).status).toBe(200);
    expect((await Db.from(env).platformApp(app, platform)).storeProfileBase64).toBe("profile");
  });

  it.each(["ios", "macos", "tvos"] as const)("withholds %s signing after deferred credential preparation", async (platform) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.secretsBlob;
    vi.spyOn(Db.prototype, "secretsBlob").mockImplementationOnce(async function (this: Db, id) {
      entered.resolve();
      await release.promise;
      return original.call(this, id);
    });
    const pending = handle(api(null, "GET", `/api/build/${app.id}/${platform}/signing`, undefined, headers()), env, deps);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve();
    await disabled(await pending);
  });

  it.each(["ios", "macos", "tvos"] as const)("retains %s upload identity when disabled between reservation writes", async (platform) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ [`POST ${apple("/v1/buildUploads")}`]: () => { entered.resolve(); return release.promise; } });
    const pending = handle(api(null, "POST", route(platform, "upload"), uploadBody(platform), headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes({ data: { id: "reserved-upload" } }));
    await disabled(await pending);
    expect(stub.calls.map((call) => call.method)).toEqual(["POST"]);
    expect(await Db.from(env).testflightBuilds(app.id, 5, platform)).toMatchObject([{ uploadId: "reserved-upload", uploadFileId: null, state: "uploading", message: null }]);
  });

  it.each(["ios", "macos", "tvos"] as const)("retains both %s identifiers but withholds operations after file creation", async (platform) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({
      [`POST ${apple("/v1/buildUploads")}`]: () => jsonRes({ data: { id: "upload" } }),
      [`POST ${apple("/v1/buildUploadFiles")}`]: () => { entered.resolve(); return release.promise; },
    });
    const pending = handle(api(null, "POST", route(platform, "upload"), uploadBody(platform), headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes({ data: { id: "file", attributes: { uploadOperations: [{ url: "https://private.example/secret", requestHeaders: [{ name: "Secret", value: "private" }] }] } } }));
    await disabled(await pending);
    expect(await Db.from(env).testflightBuilds(app.id, 5, platform)).toMatchObject([{ uploadId: "upload", uploadFileId: "file", state: "uploading", message: null }]);
  });

  it.each(["ios", "macos", "tvos"] as const)("withholds %s continuation operations after deferred Apple lookup", async (platform) => {
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "1.0", buildNumber: "7", uploadId: "upload", uploadFileId: "file", buildId: null, whatsNew: null, state: "uploading", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ [`GET ${apple("/v1/buildUploadFiles/file")}`]: () => { entered.resolve(); return release.promise; } });
    const pending = handle(api(null, "POST", route(platform, "upload/file/operations"), { version: "1.0", buildNumber: "7", fileSize: 10 }, headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes({ data: { id: "file", type: "buildUploadFiles", attributes: { assetDeliveryState: { state: "AWAITING_UPLOAD" }, fileSize: 10, uploadOperations: [{ method: "PUT", url: "https://private.example/secret", offset: 0, length: 10, requestHeaders: [{ name: "Secret", value: "private" }] }] } } }));
    await disabled(await pending);
    expect(stub.calls).toHaveLength(1);
    const statusStub = fakeFetch({ [`GET ${apple("/v1/buildUploadFiles/file")}`]: () => jsonRes({ data: { id: "file", type: "buildUploadFiles", attributes: {} } }) });
    expect((await handle(api(null, "GET", route(platform, "upload/file/status"), undefined, headers()), env, { ...deps, fetch: statusStub.fetch })).status).toBe(200);
  });

  it.each(["ios", "macos", "tvos"] as const)("blocks %s commit after deferred credentials without failing the record", async (platform) => {
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "1.0", buildNumber: "7", uploadId: "upload", uploadFileId: "file", buildId: null, whatsNew: null, state: "uploading", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.secretsBlob;
    vi.spyOn(Db.prototype, "secretsBlob").mockImplementationOnce(async function (this: Db, id) { entered.resolve(); await release.promise; return original.call(this, id); });
    const stub = fakeFetch({});
    const pending = handle(api(null, "POST", route(platform, "commit"), { uploadFileId: "file", md5: "a".repeat(32) }, headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve();
    await disabled(await pending);
    expect(stub.calls).toHaveLength(0);
    expect(await Db.from(env).testflightBuild(app.id, "file", platform)).toMatchObject({ state: "uploading", message: null });
  });

  it.each([["macos", "repository"], ["macos", "workflow"], ["tvos", "repository"], ["tvos", "workflow"]] as const)("checks %s after deferred %s metadata without changing request bookkeeping", async (platform, boundary) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ ...githubRoutes(),
      "GET api.appstoreconnect.apple.com/v1/builds": () => jsonRes({ data: [] }),
      "GET api.github.com/repos/o/skull": () => { if (boundary === "repository") { entered.resolve(); return release.promise; } return jsonRes({ default_branch: "main" }); },
      "GET api.github.com/repos/o/skull/actions/workflows/apple-testflight.yml": () => { if (boundary === "workflow") { entered.resolve(); return release.promise; } return jsonRes({ state: "active" }); },
    });
    const target = await Db.from(env).platformApp(app, platform);
    const pending = requestBuild(env, { ...deps, fetch: stub.fetch }, target, "requested");
    const rejected = expect(pending).rejects.toBeInstanceOf(TargetDisabledError);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes(boundary === "repository" ? { default_branch: "main" } : { state: "active" }));
    await rejected;
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
    expect((await Db.from(env).platformApp(app, platform)).buildRequestedAt).toBeNull();
    expect(target.buildRequestedAt).toBeNull();
  });

  it.each(["macos", "tvos"] as const)("does not allocate %s after a deferred Apple build lookup", async (platform) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ ...githubRoutes(), [`GET ${apple("/v1/builds")}`]: () => { entered.resolve(); return release.promise; } });
    const pending = handle(api(null, "POST", route(platform, "reserve-build"), undefined, headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes({ data: [] }));
    await disabled(await pending);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it.each(["macos", "tvos"] as const)("rechecks %s before returning a reused verified reservation", async (platform) => {
    await Db.from(env).associateBuildRun(app.id, platform, "1.0", "8", { repo: app.repo, runId: "101", runAttempt: "1", createdAt: deps.now().toISOString(), startedAt: deps.now().toISOString() }, deps.now().toISOString());
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.buildRunReservation;
    vi.spyOn(Db.prototype, "buildRunReservation").mockImplementationOnce(async function (this: Db, ...args) { entered.resolve(); await release.promise; return original.apply(this, args); });
    const stub = fakeFetch({
      "GET api.github.com/repos/o/skull/actions/runs/101/attempts/1": () => jsonRes({ id: 101, run_attempt: 1, workflow_id: 22, repository: { full_name: app.repo }, display_title: `Apple TestFlight ${platform} pending`, created_at: deps.now().toISOString(), run_started_at: deps.now().toISOString() }),
      "GET api.github.com/repos/o/skull/actions/workflows/22": () => jsonRes({ id: 22, path: ".github/workflows/apple-testflight.yml" }),
    });
    const pending = handle(api(null, "POST", route(platform, "reserve-build"), { runId: "101", runAttempt: "1" }, headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve();
    await disabled(await pending);
    expect(stub.calls).toHaveLength(2);
    expect(await Db.from(env).buildRunReservation(app.id, platform, app.repo, { runId: "101", runAttempt: "1" })).toMatchObject({ version: "1.0", buildNumber: "8" });
  });

  it("rechecks inside allocation after asynchronous preparation", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.reserveBuildNumber;
    vi.spyOn(Db.prototype, "reserveBuildNumber").mockImplementationOnce(async function (this: Db, ...args) { entered.resolve(); await release.promise; return original.apply(this, args); });
    const stub = fakeFetch({ ...githubRoutes(), [`GET ${apple("/v1/builds")}`]: () => jsonRes({ data: [] }) });
    const pending = handle(api(null, "POST", route("macos", "reserve-build"), undefined, headers()), env, { ...deps, fetch: stub.fetch });
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, "macos", false);
    release.resolve();
    await disabled(await pending);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
  });

  it("checks the iPhone repository event after deferred credentials", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.secretsBlob;
    vi.spyOn(Db.prototype, "secretsBlob").mockImplementationOnce(async function (this: Db, id) { entered.resolve(); await release.promise; return original.call(this, id); });
    const stub = fakeFetch({});
    const pending = requestBuild(env, { ...deps, fetch: stub.fetch }, app, "requested");
    const rejected = expect(pending).rejects.toBeInstanceOf(TargetDisabledError);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, "ios", false);
    release.resolve();
    await rejected;
    expect(stub.calls).toHaveLength(0);
    expect((await Db.from(env).appById(app.id))!.buildRequestedAt).toBeNull();
  });

  it.each(["ios", "macos", "tvos"] as const)("blocks %s profile replacement after deferred lookup", async (platform) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ ...appleRoutes({ bundleIds: [{ id: "bundle", identifier: app.bundleId }] }),
      [`GET ${apple("/v1/profiles")}`]: () => { entered.resolve(); return release.promise; },
    });
    const target = await Db.from(env).platformApp(app, platform);
    const pending = renewStoreProfile(env, client({ ...deps, fetch: stub.fetch }), target, "new-certificate");
    const rejected = expect(pending).rejects.toBeInstanceOf(TargetDisabledError);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, platform, false);
    release.resolve(jsonRes({ data: [{ id: "old", attributes: { name: platform === "ios" ? "Skull App Store" : `Skull App Store ${platform}`, expirationDate: "2020-01-01" } }] }));
    await rejected;
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["bundle", "group-create", "group-update", "review", "description"])("blocks setup %s writes after deferred Apple reads", async (step) => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    const paths: Record<string, string> = { bundle: "/v1/bundleIds", "group-create": "/v1/apps/asc/betaGroups", "group-update": "/v1/apps/asc/betaGroups", review: "/v1/apps/asc/betaAppReviewDetail", description: "/v1/apps/asc/betaAppLocalizations" };
    const stub = fakeFetch({ [`GET ${apple(paths[step]!)}`]: () => { entered.resolve(); return release.promise; }, [`GET ${apple("/v1/apps/asc")}`]: () => jsonRes({ data: { attributes: { primaryLocale: "en-US" } } }) });
    const check = () => requireTarget(env, app);
    const appleService = client({ ...deps, fetch: stub.fetch });
    const pending = step === "bundle" ? appleService.ensureBundleId(app.bundleId, app.name, false, check)
      : step.startsWith("group") ? appleService.ensureBetaGroup("asc", "Friends", check)
      : step === "review" ? appleService.setBetaReviewDetails("asc", { firstName: "A", lastName: "B", email: "test@example.com", phone: "+447700900123" }, "notes", check)
      : appleService.setBetaDescription("asc", { description: "description" }, check);
    const rejected = expect(pending).rejects.toBeInstanceOf(TargetDisabledError);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, "ios", false);
    release.resolve(jsonRes({ data: step === "review" ? { id: "review" } : step === "group-update" ? [{ id: "group", attributes: { name: "Friends", isInternalGroup: false, publicLinkEnabled: false } }] : step === "description" ? [{ id: "localization", attributes: { locale: "en-US" } }] : [] }));
    await rejected;
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["ios", "macos", "tvos"] as const)("advances already-uploaded %s builds while disabled", async (platform) => {
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "1.0", buildNumber: "7", uploadId: null, uploadFileId: "file", buildId: null, whatsNew: null, state: "uploaded", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    await Db.from(env).setAppTarget(app.id, platform, false);
    const stub = fakeFetch({
      [`GET ${apple("/v1/builds")}`]: () => jsonRes({ data: [{ id: "build", attributes: { processingState: "VALID", usesNonExemptEncryption: false } }] }),
      [`POST ${apple("/v1/betaGroups/group/relationships/builds")}`]: () => new Response(null, { status: 204 }),
      [`GET ${apple("/v1/builds/build/buildBetaDetail")}`]: () => jsonRes({ data: { id: "detail", attributes: { autoNotifyEnabled: true } } }),
      [`POST ${apple("/v1/betaAppReviewSubmissions")}`]: () => new Response(null, { status: 204 }),
    });
    await tickTestflight(env, { ...deps, fetch: stub.fetch });
    expect((await Db.from(env).testflightBuilds(app.id, 1, platform))[0]).toMatchObject({ state: "in-review", message: null, buildId: "build" });
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  it.each(["ios", "macos", "tvos"] as const)("skips disabled %s expiry quietly and resumes on the next eligible schedule", async (platform) => {
    const old = "2026-09-01T10:00:00Z";
    const target = await Db.from(env).platformApp(app, platform);
    target.buildRequestedAt = old;
    target.buildRequestError = "retained error";
    if (platform === "ios") await Db.from(env).setBuildRequest(app.id, old, "retained error");
    else await Db.from(env).setAppTestflight(target);
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "1.0", buildNumber: "7", uploadId: null, uploadFileId: "file", buildId: "build", whatsNew: null, state: "open", message: null, createdAt: old, updatedAt: old });
    await Db.from(env).setAppTarget(app.id, platform, false);
    const stub = fakeFetch({ ...githubRoutes(),
      "GET api.github.com/repos/o/skull": () => jsonRes({ default_branch: "main" }),
      "GET api.github.com/repos/o/skull/actions/workflows/apple-testflight.yml": () => jsonRes({ state: "active" }),
      "POST api.github.com/repos/o/skull/actions/workflows/apple-testflight.yml/dispatches": () => new Response(null, { status: 204 }),
      [`GET ${apple("/v1/builds")}`]: () => jsonRes({ data: [] }),
    });
    const d = { ...deps, fetch: stub.fetch };
    await tickTestflight(env, d);
    const base = (await Db.from(env).appById(app.id))!;
    expect(await Db.from(env).platformApp(base, platform)).toMatchObject({ buildRequestedAt: old, buildRequestError: "retained error" });
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
    const calls = stub.calls.length;
    expect((await handle(api(cookie, "PUT", `/api/dev/apps/${app.id}/targets/${platform}`, { enabled: true }), env, d)).status).toBe(200);
    expect(stub.calls).toHaveLength(calls);
    await tickTestflight(env, d);
    const current = (await Db.from(env).appById(app.id))!;
    expect(await Db.from(env).platformApp(current, platform)).toMatchObject({ buildRequestedAt: deps.now().toISOString(), buildRequestError: null });
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("checks after Mac installer preparation before certificate creation", async () => {
    await env.DB.prepare("DELETE FROM installer_certificates").run();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = Db.prototype.secretsBlob;
    let reads = 0;
    vi.spyOn(Db.prototype, "secretsBlob").mockImplementation(async function (this: Db, id) {
      if (++reads === 2) { entered.resolve(); await release.promise; }
      return original.call(this, id);
    });
    const stub = fakeFetch(appleRoutes());
    const target = await Db.from(env).platformApp(app, "macos");
    const pending = ensureInstallerSigning(env, { ...deps, fetch: stub.fetch }, app.developerId, client({ ...deps, fetch: stub.fetch }), () => requireTarget(env, target));
    const rejected = expect(pending).rejects.toBeInstanceOf(TargetDisabledError);
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, "macos", false);
    release.resolve();
    await rejected;
    expect(stub.calls).toHaveLength(0);
    expect(await Db.from(env).signingCertificate(app.developerId, true)).toBeNull();
  });

  it("preserves installer credentials when the certificate was created before disable", async () => {
    await env.DB.prepare("DELETE FROM installer_certificates").run();
    const entered = deferred<void>();
    const release = deferred<Response>();
    const stub = fakeFetch({ [`POST ${apple("/v1/certificates")}`]: () => { entered.resolve(); return release.promise; } });
    const target = await Db.from(env).platformApp(app, "macos");
    const pending = ensureInstallerSigning(env, { ...deps, fetch: stub.fetch }, app.developerId, client({ ...deps, fetch: stub.fetch }), () => requireTarget(env, target));
    await entered.promise;
    await Db.from(env).setAppTarget(app.id, "macos", false);
    release.resolve(jsonRes({ data: { id: "created-certificate", attributes: { name: "Installer", serialNumber: "serial", certificateContent: "certificate", expirationDate: "2099-01-01" } } }));
    await pending;
    expect(await Db.from(env).signingCertificate(app.developerId, true)).toMatchObject({ certificateId: "created-certificate" });
    expect(await Db.from(env).secretsBlob(app.developerId)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("renews the shared certificate without maintaining disabled target profiles", async () => {
    for (const platform of ["ios", "macos", "tvos"] as const) await Db.from(env).setAppTarget(app.id, platform, false);
    const stub = fakeFetch(appleRoutes());
    const result = await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await rsaPem() }), env, { ...deps, fetch: stub.fetch });
    expect(result.status).toBe(201);
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/certificates"]);
    expect(await result.json()).toMatchObject({ apps: [] });
    expect((await Db.from(env).appById(app.id))!.storeProfileBase64).toBe("profile");
  });

  it("fails closed when fresh preferences cannot be read", async () => {
    vi.spyOn(Db.prototype, "appTargets").mockRejectedValue(new Error("preference read failed"));
    const stub = fakeFetch({});
    const result = await handle(api(null, "GET", `/api/build/${app.id}/ios/signing`, undefined, headers()), env, { ...deps, fetch: stub.fetch });
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("private");
    expect(stub.calls).toHaveLength(0);
  });
});
