import { beforeEach, describe, expect, it } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { loadSecrets } from "../src/secrets.js";
import { tickTestflight } from "../src/testflight.js";
import { AppleClient } from "../src/apple.js";
import { BASE, CSR, api, apple, appleRoutes, clearDb, fakeFetch, githubRoutes, jsonRes, manifest, rsaPem, saveAppleSecrets, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let cookie: string;
let app: AppRow;
let token: string;
let linkId: string;

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch({ ...githubRoutes(), ...appleRoutes() }).fetch);
  cookie = await signIn(env, deps);
  await saveAppleSecrets(env, deps, cookie);
  expect((await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await rsaPem() }), env, deps)).status).toBe(201);
  const made = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull", bundleId: "com.example.skull" }), env, deps);
  const body = await made.json() as { app: AppRow; buildToken: string };
  app = (await Db.from(env).appById(body.app.id))!;
  token = body.buildToken;
  const linked = await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/links`, {}), env, deps);
  linkId = ((await linked.json()) as { link: { id: string } }).link.id;
});

async function configured(platform: "ios" | "macos" | "tvos") {
  const target = await Db.from(env).platformApp(app, platform);
  Object.assign(target, { ascAppId: "asc", betaGroupId: `group-${platform}`, testflightUrl: `https://testflight.apple.com/join/${platform}`, testflightLinkState: "open", testflightCheckedAt: deps.now().toISOString(), storeProfileId: `profile-${platform}`, storeProfileName: `Store ${platform}`, storeProfileUuid: `uuid-${platform}`, storeProfileBase64: `base64-${platform}` });
  await Db.from(env).setAppTestflight(target);
  if (platform === "ios") await Db.from(env).setLinkState(app.id, "open", deps.now().toISOString());
  return target;
}

const buildRequest = (appId: string, platform: string, step: string, body?: unknown) => api(null, step === "signing" ? "GET" : "POST", `/api/build/${appId}/${platform}/${step === "signing" ? step : `testflight/${step}`}`, body, { Authorization: `Bearer ${token}` });

describe("Apple platform isolation", () => {
  it.each([true, false, undefined])("gates the iOS-on-Mac invitation on Apple's explicit group flag: %s", async flag => {
    await configured("ios");
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform: "ios", version: "1.2", buildNumber: "8", uploadId: null, uploadFileId: null, buildId: "ios-build", whatsNew: null, state: "open", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    const stub = fakeFetch({ ...githubRoutes(), [`GET ${apple("/v1/betaGroups/group-ios")}`]: () => jsonRes({ data: { id: "group-ios", attributes: { iosBuildsAvailableForAppleSiliconMac: flag } } }) });
    const d = { ...deps, fetch: stub.fetch };
    const view = async (suffix = "/latest") => await (await handle(api(null, "GET", `/api/public/links/${linkId}${suffix}`), env, d)).json() as { apple: Record<string, unknown>; release?: { apple: Record<string, unknown> } };
    const expected = flag === true ? { version: "1.2", testflightUrl: "https://testflight.apple.com/join/ios" } : null;
    expect((await view()).apple).toMatchObject({ iosOnMac: expected, macos: null, tvos: null });
    expect((await view("")).release!.apple).toMatchObject({ iosOnMac: expected, macos: null });
    expect(stub.calls.filter(c => c.url.includes("/v1/betaGroups/group-ios"))).toHaveLength(1);
    await Db.from(env).setLinkState(app.id, "not-accepting", deps.now().toISOString());
    expect((await view()).apple).toMatchObject({ ios: null, iosOnMac: null, macos: null });
  });

  it("reuses a universal bundle identifier for phone and native Mac profiles", async () => {
    const secrets = await loadSecrets(env, app.developerId);
    const stub = fakeFetch({ [`GET ${apple("/v1/bundleIds")}`]: () => jsonRes({ data: [{ id: "universal", attributes: { identifier: app.bundleId, platform: "UNIVERSAL" } }] }) });
    const client = new AppleClient(env, { ...deps, fetch: stub.fetch }, { issuerId: secrets.appleIssuerId!, keyId: secrets.appleKeyId!, privateKey: secrets.applePrivateKey! });
    expect(await client.ensureBundleId(app.bundleId, app.name)).toBe("universal");
    expect(await client.ensureBundleId(app.bundleId, app.name, true)).toBe("universal");
    expect(stub.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("rejects unsupported platforms and keeps signing aliases on iOS", async () => {
    await configured("ios");
    for (const platform of ["watchos", "IOS", "windows"]) {
      const result = await handle(buildRequest(app.id, platform, "signing"), env, deps);
      expect(result.status).toBe(400);
      expect(await result.text()).toContain("expected ios, macos or tvos");
      expect((await handle(buildRequest(app.id, platform, "upload", {}), env, deps)).status).toBe(400);
      expect((await handle(api(cookie, "GET", `/api/dev/apps/${app.id}/testflight/${platform}`), env, deps)).status).toBe(400);
    }
    const alias = await handle(api(null, "GET", `/api/build/${app.id}/signing`, undefined, { Authorization: `Bearer ${token}` }), env, deps);
    expect(await alias.json()).toMatchObject({ storeProfile: { uuid: "uuid-ios" } });
    expect((await handle(buildRequest(app.id, "tvos", "signing"), env, deps)).status).toBe(404);
    await configured("tvos");
    const tv = await handle(buildRequest(app.id, "tvos", "signing"), env, deps);
    expect(await tv.json()).toMatchObject({ platform: "tvos", profileType: "TVOS_APP_STORE", storeProfile: { uuid: "uuid-tvos" }, upload: { fileExtension: ".ipa" } });
  });

  it("requires a separate installer key and returns it only for Mac", async () => {
    await configured("ios");
    await configured("macos");
    expect((await handle(buildRequest(app.id, "macos", "signing"), env, deps)).status).toBe(404);
    const { ensureInstallerSigning } = await import("../src/testflight.js");
    const secrets = await loadSecrets(env, app.developerId);
    const appleClient = new AppleClient(env, deps, { issuerId: secrets.appleIssuerId!, keyId: secrets.appleKeyId!, privateKey: secrets.applePrivateKey! });
    await ensureInstallerSigning(env, deps, app.developerId, appleClient);
    const saved = await loadSecrets(env, app.developerId);
    expect(saved.installerSigningKey).toContain("BEGIN PRIVATE KEY");
    expect(saved.signingKey).toBe(secrets.signingKey);
    expect(saved.installerSigningKey).not.toBe(saved.signingKey);
    expect(await Db.from(env).secretsBlob(app.developerId)).not.toContain("BEGIN PRIVATE KEY");
    const mac = await (await handle(buildRequest(app.id, "macos", "signing"), env, deps)).json() as Record<string, unknown>;
    expect(mac).toMatchObject({ platform: "macos", profileType: "MAC_CATALYST_APP_STORE", installerPrivateKeyPem: saved.installerSigningKey, installerCertificate: { id: "cert-ours" }, exportOptions: { installerSigningCertificate: "Apple Distribution: Test Person" }, upload: { fileExtension: ".pkg", uti: "com.apple.pkg" } });
    const ios = await (await handle(buildRequest(app.id, "ios", "signing"), env, deps)).json() as Record<string, unknown>;
    expect(ios).not.toHaveProperty("installerPrivateKeyPem");
    expect(ios).not.toHaveProperty("installerCertificate");
    const head = await handle(new Request(`${BASE}/api/build/${app.id}/macos/signing`, { method: "HEAD", headers: { Authorization: `Bearer ${token}` } }), env, deps);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("reserves package and phone uploads with the correct platform and blocks cross-platform commits", async () => {
    await configured("ios");
    await configured("macos");
    await configured("tvos");
    let sequence = 0;
    const stub = fakeFetch({
      [`POST ${apple("/v1/buildUploads")}`]: () => jsonRes({ data: { id: `upload-${++sequence}` } }),
      [`POST ${apple("/v1/buildUploadFiles")}`]: () => jsonRes({ data: { id: `file-${sequence}`, attributes: { uploadOperations: [] } } }),
      [`PATCH ${apple("/v1/buildUploadFiles/file-1")}`]: () => new Response(null, { status: 204 }),
    });
    const d = { ...deps, fetch: stub.fetch };
    for (const platform of ["macos", "tvos", "ios"] as const) {
      const body = { version: "1.0", buildNumber: "7", fileName: platform === "macos" ? "app.pkg" : "app.ipa", fileSize: 10 };
      expect((await handle(buildRequest(app.id, platform, "upload", body), env, d)).status).toBe(200);
      expect((await handle(buildRequest(app.id, platform, "upload", { ...body, fileName: platform === "macos" ? "app.ipa" : "app.pkg" }), env, d)).status).toBe(400);
    }
    expect(stub.calls.filter((c) => c.url.endsWith("/buildUploads")).map((c) => JSON.parse(c.body!).data.attributes.platform)).toEqual(["MAC_OS", "TV_OS", "IOS"]);
    expect(stub.calls.filter((c) => c.url.endsWith("/buildUploadFiles")).map((c) => JSON.parse(c.body!).data.attributes.uti)).toEqual(["com.apple.pkg", "com.apple.ipa", "com.apple.ipa"]);
    const commit = { uploadFileId: "file-1", md5: "0".repeat(32) };
    expect((await handle(buildRequest(app.id, "ios", "commit", commit), env, d)).status).toBe(404);
    expect((await handle(buildRequest(app.id, "macos", "commit", commit), env, d)).status).toBe(200);
    expect((await Db.from(env).testflightBuilds(app.id, 5, "macos"))[0].state).toBe("uploaded");
    expect((await Db.from(env).testflightBuilds(app.id))[0].state).toBe("uploading");
  });

  it("advertises only the platform with an approved unexpired build and an open invitation", async () => {
    for (const platform of ["ios", "macos", "tvos"] as const) {
      await configured(platform);
      await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: `${platform}-1`, buildNumber: "1", uploadId: null, uploadFileId: null, buildId: `build-${platform}`, whatsNew: null, state: platform === "macos" ? "open" : "in-review", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    }
    const stub = fakeFetch({ ...githubRoutes(), "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes({ ...manifest, install: { ...manifest.install, macos: { packages: [], testflight: { bundleId: app.bundleId, minOsVersion: "13.0", architectures: ["arm64", "x64"] } }, tvos: { bundleId: app.bundleId, minOsVersion: "17.0" } } }) });
    const latest = async () => (await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, { ...deps, fetch: stub.fetch })).json()) as Record<string, unknown>;
    expect(await latest()).toMatchObject({ testflightUrl: null, testflightVersion: null, apple: { ios: null, macos: { version: "macos-1", testflightUrl: "https://testflight.apple.com/join/macos" }, tvos: null } });
    await env.DB.prepare("UPDATE testflight_builds SET expires_at = '2026-01-01' WHERE platform = 'macos'").run();
    expect(await latest()).toMatchObject({ apple: { ios: null, macos: null, tvos: null } });
  });

  it("uses separate profiles and groups during setup and provisions the installer once", async () => {
    await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, deps);
    const stub = fakeFetch({ ...githubRoutes(), ...appleRoutes({ noOldProfile: true }),
      [`POST ${apple("/v1/certificates")}`]: (call) => {
        expect(JSON.parse(call.body!).data.attributes.certificateType).toBe("MAC_INSTALLER_DISTRIBUTION");
        return jsonRes({ data: { id: "installer", attributes: { name: "Mac Installer Distribution", serialNumber: "123", certificateContent: "base64", expirationDate: "2027-10-01" } } });
      },
      [`GET ${apple("/v1/apps")}`]: () => jsonRes({ data: [{ id: "asc", attributes: { bundleId: app.bundleId } }] }),
      [`GET ${apple("/v1/apps/asc/betaGroups")}`]: () => jsonRes({ data: [] }),
      [`POST ${apple("/v1/betaGroups")}`]: (call) => jsonRes({ data: { id: JSON.parse(call.body!).data.attributes.name, attributes: { publicLink: "https://testflight.apple.com/join/setup" } } }),
      "GET testflight.apple.com/join/setup": () => new Response("<title>Join the app beta</title>"),
      [`GET ${apple("/v1/apps/asc/betaAppReviewDetail")}`]: () => jsonRes({ data: { id: "review" } }),
      [`PATCH ${apple("/v1/betaAppReviewDetails/review")}`]: () => new Response(null, { status: 204 }),
      [`GET ${apple("/v1/apps/asc")}`]: () => jsonRes({ data: { attributes: { primaryLocale: "en-US" } } }),
      [`GET ${apple("/v1/apps/asc/betaAppLocalizations")}`]: () => jsonRes({ data: [] }),
      [`POST ${apple("/v1/betaAppLocalizations")}`]: () => new Response(null, { status: 204 }),
    });
    for (const platform of ["macos", "tvos", "ios"] as const) {
      const response = await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/testflight/${platform}`, {}), env, { ...deps, fetch: stub.fetch });
      expect(await response.json()).toMatchObject({ setUp: true, platform });
    }
    const profiles = stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/profiles")).map((c) => JSON.parse(c.body!).data.attributes.profileType);
    expect(profiles).toEqual(["MAC_CATALYST_APP_STORE", "TVOS_APP_STORE", "IOS_APP_STORE"]);
    expect((await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/testflight/macos`, { repair: true, nativeMac: true }), env, { ...deps, fetch: stub.fetch })).status).toBe(200);
    const nativeProfile = stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/profiles")).at(-1)!;
    expect(JSON.parse(nativeProfile.body!).data.attributes.profileType).toBe("MAC_APP_STORE");
    expect(JSON.parse(stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/bundleIds")).at(-1)!.body!).data.attributes.platform).toBe("MAC_OS");
    const db = Db.from(env);
    expect((await db.platformApp(app, "macos")).betaGroupId).toBe("Friends (ourapps) macos");
    expect((await db.platformApp(app, "tvos")).betaGroupId).toBe("Friends (ourapps) tvos");
    expect((await db.appById(app.id))!.betaGroupId).toBe("Friends (ourapps)");
    expect((await db.signingCertificate(app.developerId))!.certificateId).toBe("cert-ours");
    expect((await db.signingCertificate(app.developerId, true))!.certificateId).toBe("installer");
    expect(stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/certificates"))).toHaveLength(1);
  });

  it("requires a session for Mac setup and refuses read-only key writes", async () => {
    const makeKey = async (scope: "read" | "manage") => {
      const result = await handle(api(cookie, "POST", "/api/dev/keys", { name: scope, scope }), env, deps);
      return ((await result.json()) as { key: string }).key;
    };
    for (const scope of ["read", "manage"] as const) {
      const key = await makeKey(scope);
      const request = api(null, "POST", `/api/dev/apps/${app.id}/testflight/macos`, {}, { Authorization: `Bearer ${key}` });
      expect((await handle(request, env, deps)).status).toBe(403);
      if (scope === "read") expect((await handle(api(null, "POST", `/api/dev/apps/${app.id}/testflight/tvos`, {}, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(403);
    }
  });

  it("keeps scheduled build discovery on each build's platform", async () => {
    for (const platform of ["macos", "tvos"] as const) {
      const target = await configured(platform);
      target.testflightUrl = null;
      await Db.from(env).setAppTestflight(target);
      await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "1", buildNumber: "1", uploadId: null, uploadFileId: null, buildId: null, whatsNew: null, state: "processing", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    }
    const stub = fakeFetch({ [`GET ${apple("/v1/builds")}`]: () => jsonRes({ data: [] }), [`GET ${apple("/v1/betaGroups/group-macos")}`]: () => jsonRes({ data: { attributes: {} } }), [`GET ${apple("/v1/betaGroups/group-tvos")}`]: () => jsonRes({ data: { attributes: {} } }) });
    await tickTestflight(env, { ...deps, fetch: stub.fetch });
    expect(stub.calls.filter((c) => new URL(c.url).pathname === "/v1/builds").map((c) => new URL(c.url).searchParams.get("filter[preReleaseVersion.platform]"))).toEqual(["MAC_OS", "TV_OS"]);
  });
});
