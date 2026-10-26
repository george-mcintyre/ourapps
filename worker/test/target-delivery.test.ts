import { beforeEach, describe, expect, it } from "vitest";
import { APP_TARGET_KEYS, type AppManifest, type AppTarget } from "@my/store-shared";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { api, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, manifest, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let cookie: string;
let app: AppRow;
let linkId: string;
let source: AppManifest;

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  source = { ...structuredClone(manifest), schema: 1, install: {
    ...structuredClone(manifest.install), pwa: "https://play.example.com",
    ios: { ...manifest.install.ios, devices: ["iphone", "ipad"] },
    macos: { packages: [{ url: "https://private.example.com/app.dmg", format: "dmg", architectures: ["arm64"], minOsVersion: "14", signing: "signed", notarization: "notarized" }], testflight: { bundleId: "com.example.mac", minOsVersion: "14", architectures: ["arm64"] } },
    windows: { packages: [{ url: "https://private.example.com/app.exe", format: "exe", architectures: ["x64"], minOsVersion: "10", signing: "unsigned" }] },
    tvos: { bundleId: "com.example.tv", minOsVersion: "17" },
  } };
  const stub = fakeFetch({ ...githubRoutes(), "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes(source) });
  deps = testDeps(stub.fetch);
  cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  linkId = made.linkId;
  app = (await Db.from(env).appById(made.appId))!;
  for (const platform of ["ios", "macos", "tvos"] as const) {
    const target = await Db.from(env).platformApp(app, platform);
    Object.assign(target, { ascAppId: "asc", betaGroupId: "group", testflightUrl: `https://testflight.apple.com/join/${platform}`, testflightLinkState: "open", testflightCheckedAt: deps.now().toISOString() });
    await Db.from(env).setAppTestflight(target);
    await Db.from(env).insertTestflightBuild({ appId: app.id, platform, version: "0.1.0", buildNumber: "1", uploadId: null, uploadFileId: null, buildId: "build", whatsNew: null, state: "open", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
  }
  await Db.from(env).setLinkState(app.id, "open", deps.now().toISOString());
  await Db.from(env).setIosOnMac(app.id, true, deps.now().toISOString());
});

type Page = { deliveryRevision: string; release: { install: AppManifest["install"]; apple: Record<string, unknown>; version: string; testflightVersion: string | null }; app: { name: string }; screenshots: unknown };
type Latest = { deliveryRevision: string; testflightUrl: string | null; testflightVersion: string | null; apple: Record<string, unknown>; android: unknown; macos: unknown; windows: unknown; pwa: string | null };
async function page(preview = false): Promise<Page> {
  const response = await handle(api(preview ? cookie : null, "GET", preview ? `/api/dev/apps/${app.id}/preview` : `/api/public/links/${linkId}`), env, deps);
  expect(response.status).toBe(200);
  return response.json();
}
async function latest(): Promise<Latest> {
  const response = await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, deps);
  expect(response.status).toBe(200);
  return response.json();
}

describe("public target projection", () => {
  it.each(APP_TARGET_KEYS)("removes only %s from page, preview and updates and restores it without a release", async (target) => {
    const before = await page();
    await Db.from(env).setAppTarget(app.id, target, false);
    const key = target === "web" ? "pwa" : target;
    for (const view of [await page(), await page(true)]) {
      expect(view.release.install[key]).toBeNull();
      for (const other of APP_TARGET_KEYS.filter((value) => value !== target)) expect(view.release.install[other === "web" ? "pwa" : other]).toBeTruthy();
      expect(view.deliveryRevision).not.toBe(before.deliveryRevision);
      expect(view.release.version).toBe(before.release.version);
      expect(view.app).toEqual(before.app);
      expect(view.screenshots).toEqual(before.screenshots);
      if (["ios", "macos", "tvos"].includes(target)) expect(view.release.apple[target]).toBeNull();
      if (target === "ios" || target === "macos") expect(view.release.apple.iosOnMac).toBeNull();
    }
    const update = await latest();
    if (["android", "macos", "windows", "web"].includes(target)) expect(update[key as "android" | "macos" | "windows" | "pwa"]).toBeNull();
    if (target === "ios") expect(update).toMatchObject({ testflightUrl: null, testflightVersion: null, apple: { ios: null, iosOnMac: null } });
    if (target === "tvos") expect(update.apple.tvos).toBeNull();
    if (target === "macos") expect(update.apple).toMatchObject({ macos: null, iosOnMac: null });
    expect(update.deliveryRevision).toBe((await page()).deliveryRevision);
    const owner = await handle(api(cookie, "GET", `/api/dev/apps/${app.id}/release`), env, deps);
    expect(await owner.json()).toMatchObject({ ok: true, install: { ios: true, android: true, pwa: true, macos: true, windows: true, tvos: true } });
    expect(source.install[key]).toBeTruthy();
    await Db.from(env).setAppTarget(app.id, target, true);
    expect((await page()).deliveryRevision).toBe(before.deliveryRevision);
    expect((await latest()).deliveryRevision).toBe(before.deliveryRevision);
  });

  it("keeps all-disabled release reads successful with retained description and no delivery", async () => {
    for (const target of APP_TARGET_KEYS) await Db.from(env).setAppTarget(app.id, target, false);
    for (const view of [await page(), await page(true)]) {
      expect(Object.values(view.release.install).every((value) => value === null)).toBe(true);
      expect(Object.values(view.release.apple).every((value) => value === null)).toBe(true);
      expect(view.app.name).toBe(app.name);
      expect(view.release.testflightVersion).toBeNull();
    }
    expect(await latest()).toMatchObject({ testflightUrl: null, testflightVersion: null, android: null, macos: null, windows: null, pwa: null, apple: { ios: null, macos: null, tvos: null, iosOnMac: null } });
  });

  it("has a stable opaque revision across signed-link expiry and detects equal-count package replacement", async () => {
    const before = await page();
    deps.advance(30_000);
    const next = await page();
    expect(next.release.install.windows!.packages[0]!.url).not.toBe(before.release.install.windows!.packages[0]!.url);
    expect(next.deliveryRevision).toBe(before.deliveryRevision);
    expect(next.deliveryRevision).toMatch(/^[a-f0-9]{64}$/);
    source.install.windows!.packages[0]!.url = "https://private.example.com/replacement.exe";
    expect((await page()).deliveryRevision).not.toBe(before.deliveryRevision);
    expect((await latest()).deliveryRevision).toBe((await page()).deliveryRevision);
  });

  it("changes the revision for a new release version at unchanged delivery addresses and readiness", async () => {
    const before = await page();
    const install = structuredClone(source.install);
    source.version = "0.2.0";
    for (const after of [await page(), await page(true)]) {
      expect(after.release.version).toBe("0.2.0");
      expect(after.release.install.pwa).toBe("https://play.example.com");
      expect(after.release.install).toEqual(before.release.install);
      expect(after.release.apple).toEqual(before.release.apple);
      expect(after.deliveryRevision).not.toBe(before.deliveryRevision);
    }
    expect(source.install).toEqual(install);
    const changedRevision = (await latest()).deliveryRevision;
    expect(changedRevision).toBe((await page()).deliveryRevision);
    deps.advance(30_000);
    const renewed = await page();
    expect(renewed.release.version).toBe("0.2.0");
    expect(renewed.release.install.windows!.packages[0]!.url).not.toBe(before.release.install.windows!.packages[0]!.url);
    expect(renewed.deliveryRevision).toBe(changedRevision);
    expect(renewed.deliveryRevision).toBe((await latest()).deliveryRevision);
    expect(renewed.deliveryRevision).toBe((await page(true)).deliveryRevision);
  });
});
