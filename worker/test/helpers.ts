import { TERMS_VERSION } from "@my/store-shared";
import { env as bindings } from "cloudflare:workers";
import { expect } from "vitest";
import type { Deps, Env } from "../src/env.js";
import { handle } from "../src/index.js";

export const BASE = "https://ourapps.app";

export const manifest = {
  schema: 1,
  id: "skull",
  name: "Skull",
  version: "0.1.0",
  description: "Bluffing card game.",
  icon: "https://api.github.com/repos/o/skull/releases/assets/5",
  minPlayers: 3,
  maxPlayers: 6,
  screenshots: ["https://api.github.com/repos/o/skull/releases/assets/6", "https://cdn.example.com/2.png"],
  install: {
    pwa: null,
    android: { apk: "https://api.github.com/repos/o/skull/releases/assets/2" },
    ios: { bundleId: "com.example.skull", testflight: "https://testflight.apple.com/join/FIXTURE" },
  },
};

export type Call = { method: string; url: string; body?: string; headers: Headers };

// A fetch stub keyed by "METHOD host/path"; records every call.
export function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const call: Call = { method: req.method, url: req.url, body: req.method === "GET" ? undefined : await req.text(), headers: req.headers };
    calls.push(call);
    const key = `${req.method} ${u.host}${u.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(`no stub for ${key}`, { status: 599 });
    return handler(call);
  };
  return { fetch: fetchStub, calls };
}

export type TestDeps = Deps & { advance: (ms: number) => void };

export function testDeps(fetchStub: typeof fetch = () => Promise.resolve(new Response("no fetch", { status: 599 }))): TestDeps {
  let t = Date.parse("2026-10-16T10:00:00Z");
  return {
    fetch: fetchStub,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export async function applePem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(s)}\n-----END PRIVATE KEY-----\n`;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(bindings as unknown as Env), ...overrides };
}

export async function clearDb(env: Env): Promise<void> {
  const kv = await env.WEBAPP_FILES.list();
  await Promise.all(kv.keys.map((k) => env.WEBAPP_FILES.delete(k.name)));

  for (const table of ["audit_log", "api_keys", "build_number_reservations", "testflight_builds", "app_testflight_platforms", "installer_certificates", "links", "apps", "sessions", "signing_certificates", "developer_secrets", "developers"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export const gh = (path: string) => `api.github.com${path}`;
export const apple = (path: string) => `api.appstoreconnect.apple.com${path}`;

export const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Routes that let a GitHub sign-in complete for one user.
export function oauthRoutes(user = { id: 42, login: "george", name: "George" }) {
  return {
    "POST github.com/login/oauth/access_token": () => jsonRes({ access_token: "gho_test" }),
    [`GET ${gh("/user")}`]: () => jsonRes(user),
  };
}

// Routes that make GitHub serve the test manifest and artefacts.
export function githubRoutes() {
  return {
    [`GET ${gh("/repos/o/skull/releases/latest")}`]: () => jsonRes({ assets: [{ name: "my-app.json", url: "https://api.github.com/repos/o/skull/releases/assets/1" }] }),
    [`GET ${gh("/repos/o/skull/releases/assets/1")}`]: () => jsonRes(manifest),
    [`GET ${gh("/repos/o/skull/releases/assets/2")}`]: () => new Response("APKBYTES", { status: 200 }),
    [`GET ${gh("/repos/o/skull/releases/assets/6")}`]: () => new Response("SHOT", { status: 200, headers: { "Content-Type": "image/png" } }),
    [`GET ${gh("/repos/o/skull/releases/assets/5")}`]: () => new Response("PNGBYTES", { status: 200, headers: { "Content-Type": "image/png" } }),
    [`POST ${gh("/repos/o/skull/dispatches")}`]: () => new Response(null, { status: 204 }),
    [`GET ${gh("/repos/o/skull")}`]: () => jsonRes({ private: false }),
    [`GET ${gh("/repos/o/skull/releases")}`]: () =>
      jsonRes([
        { tag_name: "v0.2.0-rc1", name: "0.2.0 rc1", body: "soon", draft: false, prerelease: true, published_at: "2026-10-15T10:00:00Z", html_url: "https://github.com/o/skull/releases/tag/v0.2.0-rc1" },
        { tag_name: "release-0.1.0-2", name: "Skull 0.1.0 (build 2)", assets: [{ name: "CHANGELOG.md", url: "https://api.github.com/repos/o/skull/releases/assets/7" }, { name: "my-app.json", url: "https://api.github.com/repos/o/skull/releases/assets/1" }], body: "## What's Changed\n* Add rematch button by @george in https://github.com/o/skull/pull/3\n* Fix [dealing](https://x) order\n\n**Full Changelog**: https://github.com/o/skull/compare/v0.0.9...v0.1.0", draft: false, prerelease: false, published_at: "2026-10-10T10:00:00Z", html_url: "https://github.com/o/skull/releases/tag/release-0.1.0-2" },
        { tag_name: "v0.0.9", name: "First table night", body: "", draft: false, prerelease: false, published_at: "2026-09-01T10:00:00Z", html_url: "https://github.com/o/skull/releases/tag/v0.0.9" },
        { tag_name: "v0.0.8", name: null, body: "draft", draft: true, prerelease: false, published_at: null, html_url: "" },
      ]),
    [`GET ${gh("/repos/o/skull/tags")}`]: () => jsonRes([{ name: "release-0.1.0-2", commit: { sha: "abc1234567890" } }, { name: "v0.0.9", commit: { sha: "def4567890123" } }]),
    [`GET ${gh("/repos/o/skull/releases/assets/7")}`]: () => new Response("# Changelog\n\n## [Unreleased]\n- Not yet\n\n## [0.1.0] - 2026-10-10\n### Added\n- Rematch button, written for the table\n### Fixed\n- Dealing order\n\n## 0.0.1\n- Ancient\n", { status: 200 }),
    [`GET ${gh("/repos/o/skull/commits/def4567890123")}`]: () => jsonRes({ commit: { message: "Deal cards in seat order\n\nLonger explanation." } }),
  };
}

// Apple's signing side. Without `noOldProfile` an existing "Skull App Store" profile with an older
// certificate is found; bundle IDs, profiles and certificates are created on request.
export function appleRoutes(state: { profileCount?: number; noOldProfile?: boolean; bundleIds?: { id: string; identifier: string }[] } = {}) {
  const bundleIds = state.bundleIds ?? (state.bundleIds = []);
  return {
    [`GET ${apple("/v1/profiles")}`]: () =>
      jsonRes({
        data: state.noOldProfile
          ? []
          : [
              {
                id: "prof-old",
                type: "profiles",
                attributes: { name: "Skull App Store", profileType: "IOS_APP_STORE", uuid: "uuid-old", profileContent: "b64old", expirationDate: "2027-01-01T00:00:00Z" },
                relationships: { bundleId: { data: { type: "bundleIds", id: "bid-1" } }, certificates: { data: [{ type: "certificates", id: "cert-1" }] } },
              },
            ],
      }),
    [`DELETE ${apple("/v1/profiles/prof-old")}`]: () => new Response(null, { status: 204 }),
    [`POST ${apple("/v1/profiles")}`]: () => {
      const n = (state.profileCount = (state.profileCount ?? 0) + 1);
      return jsonRes({ data: { id: `prof-${n}`, type: "profiles", attributes: { uuid: `uuid-${n}`, profileContent: `b64-${n}`, expirationDate: "2027-10-01T00:00:00Z" } } }, 201);
    },
    // A prefix match comes back too, as Apple's filter may return it.
    [`GET ${apple("/v1/bundleIds")}`]: () => jsonRes({ data: [{ id: "bid-tests", type: "bundleIds", attributes: { identifier: "com.example.skull.tests" } }, ...bundleIds.map((b) => ({ id: b.id, type: "bundleIds", attributes: { identifier: b.identifier } }))] }),
    [`POST ${apple("/v1/bundleIds")}`]: (call: Call) => {
      const b = { id: `bid-new-${bundleIds.length + 1}`, identifier: JSON.parse(call.body!).data.attributes.identifier };
      bundleIds.push(b);
      return jsonRes({ data: { id: b.id, type: "bundleIds", attributes: { identifier: b.identifier } } }, 201);
    },
    [`POST ${apple("/v1/certificates")}`]: () =>
      jsonRes({ data: { id: "cert-ours", type: "certificates", attributes: { name: "Apple Distribution: Test Person", serialNumber: "5EA1", certificateContent: "Q0VSVElGSUNBVEU=", expirationDate: "2027-10-20T10:00:00.000+00:00" } } }, 201),
  };
}

export async function rsaPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(s).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nMIIBVzCBwQIBADAYMRYwFAYDVQQDDA1vdXJhcHBzIHRlc3Q=\n-----END CERTIFICATE REQUEST-----\n";

// Sign in through the stubbed OAuth flow; returns the Cookie header to use.
export async function signIn(env: Env, deps: TestDeps, user?: { id: number; login: string; name: string }, acceptTerms = true): Promise<string> {
  const stub = fakeFetch(oauthRoutes(user));
  const start = await handle(new Request(`${BASE}/api/auth/github`), env, deps);
  expect(start.status).toBe(302);
  const stateCookie = start.headers.get("Set-Cookie")!.split(";")[0];
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  const done = await handle(new Request(`${BASE}/api/auth/callback?code=abc&state=${state}`, { headers: { Cookie: stateCookie } }), env, { ...deps, fetch: stub.fetch });
  expect(done.status).toBe(302);
  expect(done.headers.get("Location")).toBe(`${BASE}/dev`);
  const cookie = done.headers.get("Set-Cookie")!.split(";")[0];
  if (acceptTerms) {
    const accepted = await handle(api(cookie, "POST", "/api/dev/terms", { version: TERMS_VERSION }), env, deps);
    expect(accepted.status).toBe(200);
  }
  return cookie;
}

export function api(cookie: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

export async function createSkull(env: Env, deps: TestDeps, cookie: string): Promise<{ appId: string; buildToken: string; linkId: string }> {
  const res = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull", tagline: "Bluff your friends" }), env, deps);
  expect(res.status).toBe(201);
  const { app, buildToken } = (await res.json()) as { app: { id: string }; buildToken: string };
  const linkRes = await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/links`, { label: "family" }), env, deps);
  expect(linkRes.status).toBe(201);
  const { link } = (await linkRes.json()) as { link: { id: string } };
  return { appId: app.id, buildToken, linkId: link.id };
}

export const GH_TOKEN = "ghp_" + "a".repeat(36);

export async function saveAppleSecrets(env: Env, deps: TestDeps, cookie: string): Promise<void> {
  const res = await handle(api(cookie, "PUT", "/api/dev/secrets", { appleIssuerId: "iss", appleKeyId: "kid", applePrivateKey: await applePem(), appleTeamId: "TEAM123456", githubToken: GH_TOKEN }), env, deps);
  expect(res.status).toBe(200);
}
