import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as bindings } from "cloudflare:workers";
import { APP_TARGET_KEYS, defaultAppTargets } from "@my/store-shared";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { sha256Hex } from "../src/crypto.js";
import { api, clearDb, createSkull, fakeFetch, githubRoutes, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let cookie: string;
let app: AppRow;
let token: string;

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  app = (await Db.from(env).appById(made.appId))!;
  token = made.buildToken;
});

const path = (target = "tvos") => `/api/dev/apps/${app.id}/targets/${target}`;
const read = (bearer = token) => handle(api(null, "GET", `/api/build/${app.id}/targets`, undefined, { Authorization: `Bearer ${bearer}` }), env, deps);

describe("target persistence and routes", () => {
  it("applies the target migration to an existing row without changing its saved fields", async () => {
    const migrations = (bindings as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const migration = migrations.find((value) => value.name === "0018_target_selection.sql")!;
    expect(migration).toBeTruthy();
    const columns = await env.DB.prepare("PRAGMA table_info(apps)").all<{ name: string }>();
    const oldColumns = columns.results.map((column) => column.name).filter((name) => !name.startsWith("target_"));
    await env.DB.prepare(`CREATE TABLE target_migration_fixture AS SELECT ${oldColumns.join(", ")} FROM apps`).run();
    try {
      const before = await env.DB.prepare("SELECT * FROM target_migration_fixture").first<Record<string, unknown>>();
      for (const query of migration.queries) await env.DB.prepare(query.replaceAll("ALTER TABLE apps", "ALTER TABLE target_migration_fixture")).run();
      const after = await env.DB.prepare("SELECT * FROM target_migration_fixture").first<Record<string, unknown>>();
      expect(after).toEqual({ ...before, ...Object.fromEntries(APP_TARGET_KEYS.map((key) => [`target_${key}`, 1])) });
    } finally {
      await env.DB.prepare("DROP TABLE target_migration_fixture").run();
    }
  });

  it.each(APP_TARGET_KEYS)("defaults and round trips %s without external calls", async (target) => {
    expect(app.targets).toEqual(defaultAppTargets());
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const enabled of [false, false, true]) {
      const response = await handle(api(cookie, "PUT", path(target), { enabled }), env, { ...deps, fetch });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ targets: { ...defaultAppTargets(), [target]: enabled } });
      expect(await (await read()).json()).toEqual({ targets: { ...defaultAppTargets(), [target]: enabled } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps concurrent different-target changes through stale broad and platform saves", async () => {
    const db = Db.from(env);
    const mac = await db.platformApp(app, "macos");
    await Promise.all([db.setAppTarget(app.id, "ios", false), db.setAppTarget(app.id, "tvos", false)]);
    await db.updateApp(app);
    await db.setAppTestflight(app);
    await db.setAppTestflight(mac);
    const current = (await db.appById(app.id))!;
    const expected = { ...defaultAppTargets(), ios: false, tvos: false };
    expect(current.targets).toEqual(expected);
    for (const platform of ["macos", "tvos"] as const) expect((await db.platformApp(current, platform)).targets).toEqual(expected);
  });

  it.each(APP_TARGET_KEYS)("enforces the database constraint for %s", async (target) => {
    await expect(env.DB.prepare(`UPDATE apps SET target_${target} = 2 WHERE id = ?`).bind(app.id).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE apps SET target_${target} = NULL WHERE id = ?`).bind(app.id).run()).rejects.toThrow();
    expect(await Db.from(env).appTargets(app.id)).toEqual(defaultAppTargets());
  });

  it.each([null, [], {}, { enabled: 0 }, { enabled: "false" }, { enabled: false, extra: true }, "{"])("rejects malformed body %j", async (body) => {
    expect((await handle(api(cookie, "PUT", path(), body), env, deps)).status).toBe(400);
    expect(await Db.from(env).appTargets(app.id)).toEqual(defaultAppTargets());
  });

  it("rejects unknown target, cross-owner, foreign origin and unaccepted terms", async () => {
    expect((await handle(api(cookie, "PUT", path("pwa"), { enabled: false }), env, deps)).status).toBe(400);
    const other = await signIn(env, deps, { id: 8, login: "other", name: "Other" });
    expect((await handle(api(other, "PUT", path(), { enabled: false }), env, deps)).status).toBe(404);
    expect((await handle(api(cookie, "PUT", path(), { enabled: false }, { Origin: "https://foreign.example" }), env, deps)).status).toBe(403);
    await env.DB.prepare("UPDATE developers SET terms_accepted_version = NULL WHERE id = ?").bind(app.developerId).run();
    expect((await handle(api(cookie, "PUT", path(), { enabled: false }), env, deps)).status).toBe(403);
    expect(await Db.from(env).appTargets(app.id)).toEqual(defaultAppTargets());
  });

  it("rejects read-only keys and build tokens as selection writers", async () => {
    const made = await handle(api(cookie, "POST", "/api/dev/keys", { name: "reader", scope: "read" }), env, deps);
    const { key } = await made.json() as { key: string };
    expect((await handle(api(null, "PUT", path(), { enabled: false }, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(403);
    expect((await handle(api(null, "PUT", path(), { enabled: false }, { Authorization: `Bearer ${token}` }), env, deps)).status).toBe(401);
    expect((await handle(api(null, "PUT", `/api/build/${app.id}/targets`, { enabled: false }, { Authorization: `Bearer ${token}` }), env, deps)).status).toBe(404);
    expect(await Db.from(env).appTargets(app.id)).toEqual(defaultAppTargets());
  });

  it("authenticates app-scoped reads without token or credential rewrites", async () => {
    const other = await createSkull(env, deps, cookie);
    expect((await read("invalid")).status).toBe(401);
    expect((await read(other.buildToken)).status).toBe(401);
    expect((await handle(api(null, "GET", `/api/build/${app.id}/targets`), env, deps)).status).toBe(401);
    const hash = await sha256Hex(token);
    await Db.from(env).rehashBuildToken(app.id, hash);
    const secrets = await Db.from(env).secretsBlob(app.developerId);
    const result = await read();
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect((await Db.from(env).appById(app.id))!.buildTokenHash).toBe(hash);
    expect(await Db.from(env).secretsBlob(app.developerId)).toBe(secrets);
  });
});
