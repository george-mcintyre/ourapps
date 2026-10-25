import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { errorResponse, handle } from "../src/index.js";
import { BASE, CSR, GH_TOKEN, api, jsonRes, type Call, manifest, appleRoutes, applePem, clearDb, createSkull, fakeFetch, githubRoutes, rsaPem, saveAppleSecrets, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

let env: Env;
let deps: TestDeps;
let cookie: string;

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
});

describe("apps", () => {
  it("creates an app, returns the build token once, and lists it", async () => {
    const res = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull", screenshots: ["https://x/1.png", ""], showOnPage: true }), env, deps);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { app: Record<string, unknown>; buildToken: string };
    expect(body.buildToken).toMatch(/^[0-9a-f]{48}$/);
    expect(body.app).toMatchObject({ name: "Skull", repo: "o/skull", screenshots: ["https://x/1.png"], showOnPage: true });
    expect(body.app.buildTokenHash).toBeUndefined();
    const list = (await (await handle(api(cookie, "GET", "/api/dev/apps"), env, deps)).json()) as { apps: { id: string; releaseIcon: string }[] };
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0].releaseIcon).toMatch(new RegExp(`^${BASE}/dl/`));
    const offline = (await (await handle(api(cookie, "GET", "/api/dev/apps"), env, testDeps())).json()) as { apps: { releaseIcon: string }[] };
    expect(offline.apps[0].releaseIcon).toBe("");
  });

  it("validates input", async () => {
    expect((await handle(api(cookie, "POST", "/api/dev/apps", { name: "", repo: "o/skull" }), env, deps)).status).toBe(400);
    expect((await handle(api(cookie, "POST", "/api/dev/apps", { name: "X", repo: "nope" }), env, deps)).status).toBe(400);
    expect((await handle(api(cookie, "POST", "/api/dev/apps", { name: "X", repo: "o/x", iconUrl: "http://x" }), env, deps)).status).toBe(400);
  });

  it("updates, rotates the token and deletes, only for the owner", async () => {
    const { appId, buildToken } = await createSkull(env, deps, cookie);
    const upd = await handle(api(cookie, "PUT", `/api/dev/apps/${appId}`, { tagline: "New line" }), env, deps);
    expect(((await upd.json()) as { app: { tagline: string; name: string } }).app).toMatchObject({ tagline: "New line", name: "Skull" });

    const other = await signIn(env, deps, { id: 9, login: "sue", name: "Sue" });
    expect((await handle(api(other, "GET", `/api/dev/apps/${appId}`), env, deps)).status).toBe(404);
    expect((await handle(api(other, "DELETE", `/api/dev/apps/${appId}`), env, deps)).status).toBe(404);

    const rot = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/build-token`), env, deps)).json()) as { buildToken: string };
    expect(rot.buildToken).not.toBe(buildToken);
    expect((await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, { Authorization: `Bearer ${buildToken}` }), env, deps)).status).toBe(401);
    expect((await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, { Authorization: `Bearer ${rot.buildToken}` }), env, deps)).status).toBe(404);

    expect((await handle(api(cookie, "DELETE", `/api/dev/apps/${appId}`), env, deps)).status).toBe(200);
    expect((await handle(api(cookie, "GET", `/api/dev/apps/${appId}`), env, deps)).status).toBe(404);
  });
});

describe("share links and public pages", () => {
  it("streams desktop packages through expiring signed downloads", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const base = { architectures: ["arm64", "x64"], minOsVersion: "14.0", signing: "unsigned" };
    const { fetch, calls } = fakeFetch({
      ...githubRoutes(),
      "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes({ ...manifest, install: { ...manifest.install,
        macos: { packages: [{ ...base, format: "dmg", notarization: "not-notarized", url: "https://api.github.com/repos/o/skull/releases/assets/80" }] },
        windows: { packages: [{ ...base, format: "exe", url: "https://api.github.com/repos/o/skull/releases/assets/81" }] },
      } }),
      "GET api.github.com/repos/o/skull/releases/assets/80": () => new Response(new Uint8Array([0, 255, 1, 128])),
      "GET api.github.com/repos/o/skull/releases/assets/81": () => new Response(new Uint8Array([77, 90, 0, 255])),
    });
    const d = { ...deps, fetch };
    const body = await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d)).json() as { release: { install: Record<string, { packages: { url: string }[] }> } };
    for (const [platform, format, bytes] of [["macos", "dmg", [0, 255, 1, 128]], ["windows", "exe", [77, 90, 0, 255]]] as const) {
      const url = body.release.install[platform].packages[0].url;
      expect(url).toMatch(new RegExp(`^${BASE}/dl/`));
      const got = await handle(new Request(url), env, d);
      expect(got.headers.get("Content-Disposition")).toBe(`attachment; filename="app.${format}"`);
      expect([...new Uint8Array(await got.arrayBuffer())]).toEqual(bytes);
      expect(calls.at(-1)!.headers.get("Authorization")).toBe(`Bearer ${GH_TOKEN}`);
      const altered = url.slice(0, -4) + "bad!";
      expect((await handle(new Request(altered), env, d)).status).toBe(403);
    }
    deps.advance(3_601_000);
    for (const platform of ["macos", "windows"]) expect((await handle(new Request(body.release.install[platform].packages[0].url), env, d)).status).toBe(403);
  });
  it("serves the install page with signed artefact links", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const { fetch, calls } = fakeFetch(githubRoutes());
    const d = { ...deps, fetch };
    const res = await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { name: string; tagline: string }; developer: { displayName: string }; release: { version: string; fallbackIcon: string; fallbackScreenshots: string[]; install: { android: { apk: string }; ios: { testflight: string } } } };
    expect(body.release.fallbackIcon).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(body.release.fallbackScreenshots[0]).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(body.release.fallbackScreenshots[1]).toBe("https://cdn.example.com/2.png");
    expect(await (await handle(new Request(body.release.fallbackScreenshots[0]), env, d)).text()).toBe("SHOT");
    const icon = await handle(new Request(body.release.fallbackIcon), env, d);
    expect(icon.headers.get("Content-Type")).toBe("image/png");
    expect(await icon.text()).toBe("PNGBYTES");
    expect(body.app).toMatchObject({ name: "Skull", tagline: "Bluff your friends" });
    expect(body.developer.displayName).toBe("George");
    expect(body.release.version).toBe("0.1.0");
    expect(body.release.install.android.apk).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${GH_TOKEN}`);

    const apk = await handle(new Request(body.release.install.android.apk), env, d);
    expect(apk.headers.get("Content-Type")).toBe("application/vnd.android.package-archive");
    expect(await apk.text()).toBe("APKBYTES");
    expect(body.release.install.ios.testflight).toBe("https://testflight.apple.com/join/FIXTURE");
  });

  it("builds the revision history from releases, tags and commits", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, deps)).json()) as { history: Record<string, unknown>[] };
    expect(body.history).toHaveLength(2);
    expect(body.history[0]).toEqual({
      version: "0.1.0",
      tag: "release-0.1.0-2",
      title: "",
      notes: "Added:\n- Rematch button, written for the table\nFixed:\n- Dealing order",
      date: "2026-10-10T10:00:00Z",
      sha: "abc1234567890",
      releaseUrl: "https://github.com/o/skull/releases/tag/release-0.1.0-2",
      commitUrl: "https://github.com/o/skull/commit/abc1234567890",
    });
    expect(body.history[1]).toMatchObject({ version: "0.0.9", title: "First table night", notes: "Deal cards in seat order\n\nLonger explanation.", sha: "def4567890123" });
  });

  it("orders history by publish date, not by GitHub's list order", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull/releases"] = () =>
      jsonRes([
        { tag_name: "v0.9.0", name: "Skull 0.9.0", body: "older", draft: false, prerelease: false, published_at: "2026-10-18T07:15:33Z", html_url: "x" },
        { tag_name: "v0.11.3", name: "Skull 0.11.3", body: "newest", draft: false, prerelease: false, published_at: "2026-10-18T15:49:08Z", html_url: "x" },
        { tag_name: "v0.10.0", name: "Skull 0.10.0", body: "middle", draft: false, prerelease: false, published_at: "2026-10-18T09:50:58Z", html_url: "x" },
      ]);
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { history: { version: string }[] };
    expect(body.history.map((h) => h.version)).toEqual(["0.11.3", "0.10.0", "0.9.0"]);
  });

  it("falls back to the release body when a version is missing from the changelog", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull/releases/assets/7"] = () => new Response("# Changelog\n\n## [9.9.9]\n- other\n", { status: 200 });
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { history: { notes: string }[] };
    expect(body.history[0].notes).toBe("What's Changed\n- Add rematch button\n- Fix dealing order");
  });

  it("reports whether the latest release ships a changelog", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { appId } = await createSkull(env, deps, cookie);
    const status = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, deps)).json()) as { changelog: boolean };
    expect(status.changelog).toBe(false);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull/releases/latest"] = () => new Response(JSON.stringify({ tag_name: "v1", assets: [{ name: "my-app.json", url: "https://api.github.com/repos/o/skull/releases/assets/1" }, { name: "CHANGELOG.md", url: "https://api.github.com/repos/o/skull/releases/assets/7" }] }), { status: 200 });
    const with_ = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { changelog: boolean };
    expect(with_.changelog).toBe(true);
  });

  it("hides GitHub links for private repositories and survives missing history", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull"] = () => new Response(JSON.stringify({ private: true }), { status: 200 });
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { history: { commitUrl: string | null; releaseUrl: string | null; sha: string }[] };
    expect(body.history[0]).toMatchObject({ commitUrl: null, releaseUrl: null, sha: "abc1234567890" });

    const { linkId: other } = await createSkull(env, deps, cookie);
    const bare = githubRoutes();
    delete bare["GET api.github.com/repos/o/skull/releases"];
    const none = (await (await handle(api(null, "GET", `/api/public/links/${other}`), env, { ...deps, fetch: fakeFetch(bare).fetch })).json()) as { history: unknown[]; release: unknown };
    expect(none.history).toEqual([]);
    expect(none.release).not.toBeNull();
  });

  it("serves screenshot sets per platform: dashboard first, then my-app.json, all signed when private", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { appId, linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull/releases/assets/1"] = () =>
      jsonRes({ ...manifest, screenshotsByPlatform: { ipad: ["https://api.github.com/repos/o/skull/releases/assets/8"], web: ["https://cdn.example.com/web.png"], android: [] } });
    const d = { ...deps, fetch: fakeFetch(routes).fetch };
    // Dashboard: an iPhone list and a web list; the web list must win over the release's.
    const put = await handle(api(cookie, "PUT", `/api/dev/apps/${appId}`, { screenshotsByPlatform: { iphone: ["https://cdn.example.com/i1.png", ""], web: ["https://cdn.example.com/dash-web.png"] } }), env, d);
    expect(((await put.json()) as { app: { screenshotsByPlatform: unknown } }).app.screenshotsByPlatform).toEqual({ iphone: ["https://cdn.example.com/i1.png"], web: ["https://cdn.example.com/dash-web.png"] });
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d)).json()) as { screenshots: Record<string, string[]> };
    expect(body.screenshots.iphone).toEqual(["https://cdn.example.com/i1.png"]);
    expect(body.screenshots.web).toEqual(["https://cdn.example.com/dash-web.png"]);
    expect(body.screenshots.ipad[0]).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(body.screenshots.android).toBeUndefined();
    expect(body.screenshots.all[0]).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(body.screenshots.all[1]).toBe("https://cdn.example.com/2.png");
  });

  it("rejects bad screenshotsByPlatform input", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    for (const bad of [["x"], { iPhone: ["https://x/1.png"] }, { ipad: "https://x/1.png" }, { web: Array(11).fill("https://x/1.png") }, { android: ["http://x/1.png"] }]) {
      expect((await handle(api(cookie, "PUT", `/api/dev/apps/${appId}`, { screenshotsByPlatform: bad }), env, deps)).status).toBe(400);
    }
  });

  it("still serves details when the release cannot be loaded, without naming the repository", async () => {
    const { appId, linkId } = await createSkull(env, deps, cookie);
    // A private repository: no GitHub links in the history either.
    const hidden = { ...githubRoutes(), "GET api.github.com/repos/o/skull": () => jsonRes({ private: true }), "GET api.github.com/repos/o/skull/releases/latest": () => new Response("{}", { status: 404 }) };
    const d = { ...deps, fetch: fakeFetch(hidden).fetch };
    const res = await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { release: null; releaseError: string };
    expect(body.release).toBeNull();
    expect(body.releaseError).toBe("no published build yet");
    expect(text).not.toContain("o/skull");
    // The developer's preview keeps the reason.
    const preview = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/preview`), env, d)).json()) as { releaseError: string };
    expect(preview.releaseError).toMatch(/o\/skull/);
  });

  it("refuses expired and tampered artefact links", async () => {
    const { linkId } = await createSkull(env, deps, cookie);
    const body = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, deps)).json()) as { release: { install: { android: { apk: string } } } };
    deps.advance(61 * 60 * 1000);
    expect((await handle(new Request(body.release.install.android.apk), env, deps)).status).toBe(403);
    expect((await handle(new Request(`${body.release.install.android.apk}x`), env, deps)).status).toBe(403);
  });

  it("renames a link without changing its address", async () => {
    const { appId, linkId } = await createSkull(env, deps, cookie);
    const res = await handle(api(cookie, "PUT", `/api/dev/links/${linkId}`, { label: "  Thursday table  " }), env, deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { link: { id: string; label: string } }).link).toMatchObject({ id: linkId, label: "Thursday table" });
    const detail = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}`), env, deps)).json()) as { links: { id: string; label: string }[] };
    expect(detail.links.find((l) => l.id === linkId)!.label).toBe("Thursday table");
    expect((await handle(api(null, "GET", `/api/public/links/${linkId}`), env, deps)).status).toBe(200);
    const long = (await (await handle(api(cookie, "PUT", `/api/dev/links/${linkId}`, { label: "x".repeat(200) }), env, deps)).json()) as { link: { label: string } };
    expect(long.link.label.length).toBe(80);
    expect((await handle(api(cookie, "PUT", `/api/dev/links/${linkId}`, { label: 5 }), env, deps)).status).toBe(400);
    const other = await signIn(env, deps, { id: 9, login: "sue", name: "Sue" });
    expect((await handle(api(other, "PUT", `/api/dev/links/${linkId}`, { label: "mine" }), env, deps)).status).toBe(404);
  });

  it("treats revoked and expired share links as inactive", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    const expiring = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/links`, { label: "short", expiresAt: "2026-10-16T11:00:00Z" }), env, deps)).json()) as { link: { id: string } };
    expect((await handle(api(null, "GET", `/api/public/links/${expiring.link.id}`), env, deps)).status).toBe(200);
    deps.advance(2 * 3600_000);
    expect((await handle(api(null, "GET", `/api/public/links/${expiring.link.id}`), env, deps)).status).toBe(410);

    const live = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/links`, {}), env, deps)).json()) as { link: { id: string } };
    expect((await handle(api(cookie, "POST", `/api/dev/links/${live.link.id}/revoke`), env, deps)).status).toBe(200);
    expect((await handle(api(null, "GET", `/api/public/links/${live.link.id}`), env, deps)).status).toBe(410);
    expect((await handle(api(null, "GET", `/api/public/links/${live.link.id}/latest`), env, deps)).status).toBe(410);
    expect((await handle(api(null, "GET", "/api/public/links/nope"), env, deps)).status).toBe(404);
  });

  it("shows only opted-in apps on the developer page", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    await handle(api(cookie, "POST", "/api/dev/apps", { name: "Hidden", repo: "o/hidden" }), env, deps);
    await handle(api(cookie, "PUT", `/api/dev/apps/${appId}`, { showOnPage: true }), env, deps);
    const res = await handle(api(null, "GET", "/api/public/dev/george"), env, deps);
    const body = (await res.json()) as { developer: { displayName: string }; apps: Record<string, unknown>[] };
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].name).toBe("Skull");
    expect(body.apps[0].repo).toBeUndefined();
    expect((await handle(api(null, "GET", "/api/public/dev/nobody"), env, deps)).status).toBe(404);
  });
});

describe("iPhone signing", () => {
  type SetUp = { signing: { name: string; expirationDate: string } | null; apps: { id: string; name: string; error: string | null }[] };

  it("creates the certificate, keeps its key encrypted, and serves it to builds once TestFlight is set up", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const made = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull", bundleId: "com.example.skull" }), env, deps);
    const { app, buildToken } = (await made.json()) as { app: { id: string }; buildToken: string };
    const { fetch, calls } = fakeFetch({ ...githubRoutes(), ...appleRoutes({ noOldProfile: true }) });
    const d = { ...deps, fetch };
    const key = await rsaPem();

    const res = await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: key }), env, d);
    expect(res.status).toBe(201);
    const body = (await res.json()) as SetUp;
    expect(body.signing).toMatchObject({ name: "Apple Distribution: Test Person", expirationDate: "2027-10-20T10:00:00.000+00:00" });
    // No app is on TestFlight yet, so no profile is touched.
    expect(body.apps).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/v1/profiles"))).toBe(false);
    const cert = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/certificates"))!;
    expect(JSON.parse(cert.body!).data.attributes).toEqual({ certificateType: "DISTRIBUTION", csrContent: CSR.trim() });

    const me = (await (await handle(api(cookie, "GET", "/api/dev/me"), env, d)).json()) as { secrets: { signing: { name: string } | null } };
    expect(me.secrets.signing?.name).toBe("Apple Distribution: Test Person");
    const blob = (await env.DB.prepare("SELECT blob FROM developer_secrets").first<{ blob: string }>())!.blob;
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain(key.split("\n")[1]);

    // Builds get nothing until the app is on TestFlight.
    const auth = { Authorization: `Bearer ${buildToken}` };
    expect((await handle(api(null, "HEAD", `/api/build/${app.id}/signing`, undefined, auth), env, d)).status).toBe(404);
    const early = await handle(api(null, "GET", `/api/build/${app.id}/signing`, undefined, auth), env, d);
    expect(((await early.json()) as { error: string }).error).toMatch(/TestFlight is not set up/);
    await env.DB.prepare("UPDATE apps SET asc_app_id = 'asc-1', beta_group_id = 'grp-1', testflight_url = 'https://testflight.apple.com/join/AbCd', store_profile_id = 'prof-s', store_profile_uuid = 'uuid-s', store_profile_name = 'Skull App Store', store_profile_base64 = 'b64-s' WHERE id = ?").bind(app.id).run();
    expect((await handle(api(null, "HEAD", `/api/build/${app.id}/signing`, undefined, auth), env, d)).status).toBe(200);
    const got = await handle(api(null, "GET", `/api/build/${app.id}/signing`, undefined, auth), env, d);
    expect(got.headers.get("Cache-Control")).toBe("no-store");
    expect(await got.json()).toEqual({
      certificate: { id: "cert-ours", name: "Apple Distribution: Test Person", serialNumber: "5EA1", expirationDate: "2027-10-20T10:00:00.000+00:00", base64: "Q0VSVElGSUNBVEU=" },
      privateKeyPem: key.trim(),
      teamId: "TEAM123456",
      storeProfile: { profileName: "Skull App Store", profileId: "prof-s", uuid: "uuid-s", profileBase64: "b64-s" },
      testflight: { url: "https://testflight.apple.com/join/AbCd" },
    });
    expect((await handle(api(null, "GET", `/api/build/${app.id}/signing`, undefined, { Authorization: "Bearer wrong" }), env, d)).status).toBe(401);

    // A replaced certificate goes into the App Store profile of every app on TestFlight.
    const again = await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await rsaPem() }), env, d);
    expect(((await again.json()) as SetUp).apps).toEqual([{ id: app.id, name: "Skull", error: null }]);
    const profile = JSON.parse(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/profiles")).at(-1)!.body!).data;
    expect(profile.attributes).toEqual({ name: "Skull App Store", profileType: "IOS_APP_STORE" });
    expect(profile.relationships.certificates.data).toEqual([{ type: "certificates", id: "cert-ours" }]);
  });

  it("refuses bad input, API keys and missing Apple keys; Settings cannot write the signing key", async () => {
    const { appId, buildToken } = await createSkull(env, deps, cookie);
    const auth = { Authorization: `Bearer ${buildToken}` };
    expect((await handle(api(null, "HEAD", `/api/build/${appId}/signing`, undefined, auth), env, deps)).status).toBe(404);
    const missing = await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, auth), env, deps);
    expect(((await missing.json()) as { error: string }).error).toMatch(/not set up/);

    const key = await rsaPem();
    const noApple = await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: key }), env, deps);
    expect(noApple.status).toBe(409);
    await saveAppleSecrets(env, deps, cookie);
    expect((await handle(api(cookie, "POST", "/api/dev/signing", { csr: "nope", privateKey: key }), env, deps)).status).toBe(400);
    expect((await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await applePem() }), env, deps)).status).toBe(400);
    const { key: apiKey } = (await (await handle(api(cookie, "POST", "/api/dev/keys", { name: "agent" }), env, deps)).json()) as { key: string };
    expect((await handle(api(null, "POST", "/api/dev/signing", { csr: CSR, privateKey: key }, { Authorization: `Bearer ${apiKey}` }), env, deps)).status).toBe(403);

    const put = await handle(api(cookie, "PUT", "/api/dev/secrets", { signingKey: key }), env, deps);
    expect(((await put.json()) as { secrets: { signing: unknown } }).secrets.signing).toBeNull();
    const fields = await env.DB.prepare("SELECT blob FROM developer_secrets").first<{ blob: string }>();
    expect(Object.keys(JSON.parse(fields!.blob).fields)).not.toContain("signingKey");

    expect((await handle(api(cookie, "PUT", `/api/dev/apps/${appId}`, { bundleId: "not a bundle id" }), env, deps)).status).toBe(400);
  });
});

describe("API keys and agent endpoints", () => {
  it("creates a key from the dashboard and accepts it as a bearer", async () => {
    const res = await handle(api(cookie, "POST", "/api/dev/keys", { name: "My agent" }), env, deps);
    expect(res.status).toBe(201);
    const { key, apiKey } = (await res.json()) as { key: string; apiKey: { id: string; prefix: string; name: string; keyHash?: string } };
    expect(key).toMatch(/^oa_[0-9a-f]{40}$/);
    expect(apiKey).toMatchObject({ name: "My agent", prefix: key.slice(0, 11) });
    expect(apiKey.keyHash).toBeUndefined();

    const me = await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: `Bearer ${key}` }), env, deps);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { authVia: string }).authVia).toBe("key");

    const created = await handle(api(null, "POST", "/api/dev/apps", { name: "Agent app", repo: "o/skull" }, { Authorization: `Bearer ${key}` }), env, deps);
    expect(created.status).toBe(201);

    const list = (await (await handle(api(cookie, "GET", "/api/dev/keys"), env, deps)).json()) as { keys: { id: string; lastUsedAt: string | null }[] };
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0].lastUsedAt).not.toBeNull();

    expect((await handle(api(null, "POST", "/api/dev/keys", { name: "x" }, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(403);
    expect((await handle(api(null, "DELETE", `/api/dev/keys/${apiKey.id}`, undefined, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(403);

    expect((await handle(api(cookie, "DELETE", `/api/dev/keys/${apiKey.id}`), env, deps)).status).toBe(200);
    expect((await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(401);
    expect((await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: "Bearer oa_nope" }), env, deps)).status).toBe(401);
  });

  it("keys are scoped to their developer", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    const other = await signIn(env, deps, { id: 9, login: "sue", name: "Sue" });
    const { key } = (await (await handle(api(other, "POST", "/api/dev/keys", {}), env, deps)).json()) as { key: string };
    expect((await handle(api(null, "GET", `/api/dev/apps/${appId}`, undefined, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(404);
  });

  it("refuses cookie writes from another origin", async () => {
    const evil = await handle(api(cookie, "POST", "/api/dev/apps", { name: "X", repo: "o/x" }, { Origin: "https://evil.example" }), env, deps);
    expect(evil.status).toBe(403);
    const same = await handle(api(cookie, "POST", "/api/dev/apps", { name: "X", repo: "o/x" }, { Origin: env.PUBLIC_ORIGIN }), env, deps);
    expect(same.status).toBe(201);
  });

  it("reports release status", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { appId } = await createSkull(env, deps, cookie);
    const ok = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, deps)).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, version: "0.1.0", githubToken: true, appleKey: true, install: { ios: true, android: true, pwa: false }, screenshots: 2, errors: [] });
    expect(ok.assets).toEqual(["my-app.json"]);

    const offline = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, testDeps())).json()) as { ok: boolean; errors: string[] };
    expect(offline.ok).toBe(false);
    expect(offline.errors[0]).toMatch(/599/);

    const hidden = { ...githubRoutes(), "GET api.github.com/repos/o/skull/releases/latest": () => new Response("{}", { status: 404 }) };
    const withToken = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, { ...deps, fetch: fakeFetch(hidden).fetch })).json()) as { errors: string[] };
    expect(withToken.errors[0]).toMatch(/does not include this repository/);

    const noToken = await signIn(env, deps, { id: 11, login: "tom", name: "Tom" });
    const { app } = (await (await handle(api(noToken, "POST", "/api/dev/apps", { name: "Private", repo: "o/private" }), env, deps)).json()) as { app: { id: string } };
    const routes = { "GET api.github.com/repos/o/private/releases/latest": () => new Response("{}", { status: 404 }) };
    const missing = (await (await handle(api(noToken, "GET", `/api/dev/apps/${app.id}/release`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { errors: string[] };
    expect(missing.errors[0]).toMatch(/GitHub token/);
  });

  it("reports where the web version is hosted and whether the developer's address answers", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    const check = async (pwa: string, assets: string[], site?: number) => {
      const routes: Record<string, (c: Call) => Response> = {
        ...githubRoutes(),
        "GET api.github.com/repos/o/skull/releases/latest": () => jsonRes({ assets: [{ name: "my-app.json", url: "https://api.github.com/repos/o/skull/releases/assets/1" }, ...assets.map((name, i) => ({ name, url: `https://api.github.com/repos/o/skull/releases/assets/${20 + i}` }))] }),
        "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes({ ...manifest, install: { ...manifest.install, pwa } }),
      };
      if (site !== undefined) routes["GET skull.dev-name.workers.dev/"] = () => new Response("<!doctype html>", { status: site });
      const res = await handle(api(cookie, "GET", `/api/dev/apps/${appId}/release`), env, { ...deps, fetch: fakeFetch(routes).fetch });
      return ((await res.json()) as { web: unknown }).web;
    };
    expect(await check("https://api.github.com/repos/o/skull/releases/assets/20", ["web.zip"])).toEqual({ hosting: "ourapps", url: null, ok: null, status: null });
    expect(await check("https://skull.dev-name.workers.dev/", [], 200)).toEqual({ hosting: "own", url: "https://skull.dev-name.workers.dev/", ok: true, status: 200 });
    expect(await check("https://skull.dev-name.workers.dev/", [], 404)).toEqual({ hosting: "own", url: "https://skull.dev-name.workers.dev/", ok: false, status: 404 });
    expect(await check("https://skull.dev-name.workers.dev/", [])).toMatchObject({ hosting: "own", ok: false });
  });

  it("tells an installed app what the latest version is, with fresh install links", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const res = await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string; testflightUrl: string; android: { apkUrl: string }; pwa: null; linksExpireAt: string };
    expect(body).toMatchObject({ name: "Skull", version: "0.1.0", pwa: null, testflightUrl: null, testflightVersion: null, apple: { ios: null, macos: null, tvos: null }, linksExpireAt: "2026-10-16T11:00:00.000Z" });
    expect(body).not.toHaveProperty("ios");
    expect(body.android.apkUrl).toMatch(new RegExp(`^${BASE}/dl/`));
    expect(await (await handle(new Request(body.android.apkUrl), env, deps)).text()).toBe("APKBYTES");
    await handle(api(cookie, "POST", `/api/dev/links/${linkId}/revoke`), env, deps);
    expect((await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, deps)).status).toBe(410);
  });

  it("passes install.ios.devices through to the install page", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    // A field the schema does not know, such as a repository asset address, never reaches the page.
    routes["GET api.github.com/repos/o/skull/releases/assets/1"] = () => jsonRes({ ...manifest, install: { ...manifest.install, ios: { ...manifest.install.ios, adhoc: "https://api.github.com/repos/o/skull/releases/assets/3", devices: ["iphone", "ipad"] } } });
    const res = await handle(api(null, "GET", `/api/public/links/${linkId}`), env, { ...deps, fetch: fakeFetch(routes).fetch });
    const text = await res.text();
    expect(text).not.toContain("assets/3");
    const body = JSON.parse(text) as { release: { install: { ios: { devices: string[] } } } };
    expect(body.release.install.ios).toEqual({ bundleId: "com.example.skull", testflight: "https://testflight.apple.com/join/FIXTURE", devices: ["iphone", "ipad"] });
  });

  it("hides internal detail of unexpected errors from public endpoints", async () => {
    await saveAppleSecrets(env, deps, cookie);
    const { linkId } = await createSkull(env, deps, cookie);
    const routes = githubRoutes();
    routes["GET api.github.com/repos/o/skull/releases/latest"] = () => new Response("{}", { status: 404 });
    const res = await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, { ...deps, fetch: fakeFetch(routes).fetch });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "no release of this app is available right now" }));
    expect(text).not.toContain("o/skull");
    // Any other unexpected error gives a reference only.
    const generic = errorResponse(new Request(`${BASE}/x`, { headers: { "cf-ray": "abc123" } }), new Error("D1_ERROR: no such table: secrets at offset 14"));
    expect(generic.status).toBe(500);
    expect(await generic.text()).toBe(JSON.stringify({ error: "something went wrong (reference abc123)" }));
    // Deliberate messages still come through.
    expect(((await (await handle(api(null, "GET", "/api/public/links/nope/latest"), env, deps)).json()) as { error: string }).error).toBe("no app behind this link");
  });

  it("previews the install page and serves a QR for active links", async () => {
    const { appId, linkId } = await createSkull(env, deps, cookie);
    const preview = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/preview`), env, deps)).json()) as { preview: boolean; linkId: null; app: { name: string }; release: { version: string } | null };
    expect(preview.preview).toBe(true);
    expect(preview.linkId).toBeNull();
    expect(preview.app.name).toBe("Skull");
    expect(preview.release?.version).toBe("0.1.0");

    const qr = await handle(api(null, "GET", `/api/public/links/${linkId}/qr.svg`), env, deps);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await qr.text()).toMatch(/^<svg/);
    expect((await handle(api(null, "GET", "/api/public/links/nope/qr.svg"), env, deps)).status).toBe(404);
  });
});

describe("token hardening", () => {
  it("stores keyed hashes and upgrades legacy plain hashes on use", async () => {
    const { appId, buildToken } = await createSkull(env, deps, cookie);
    const row = () => env.DB.prepare("SELECT build_token_hash AS h FROM apps WHERE id = ?").bind(appId).first<{ h: string }>();
    expect((await row())!.h.startsWith("h2:")).toBe(true);
    // Simulate a token stored before peppering.
    const plain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(buildToken))), (b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE apps SET build_token_hash = ? WHERE id = ?").bind(plain, appId).run();
    expect((await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, { Authorization: `Bearer ${buildToken}` }), env, deps)).status).toBe(404);
    expect((await row())!.h.startsWith("h2:")).toBe(true);
    expect((await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, { Authorization: "Bearer wrong" }), env, deps)).status).toBe(401);

    const { key, apiKey } = (await (await handle(api(cookie, "POST", "/api/dev/keys", { name: "k" }), env, deps)).json()) as { key: string; apiKey: { id: string } };
    const keyPlain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))), (b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE api_keys SET key_hash = ? WHERE id = ?").bind(keyPlain, apiKey.id).run();
    expect((await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: `Bearer ${key}` }), env, deps)).status).toBe(200);
    const stored = await env.DB.prepare("SELECT key_hash AS h FROM api_keys WHERE id = ?").bind(apiKey.id).first<{ h: string }>();
    expect(stored!.h.startsWith("h2:")).toBe(true);
    expect(stored!.h).not.toContain(keyPlain);
  });

  it("enforces key scope and expiry", async () => {
    const { appId } = await createSkull(env, deps, cookie);
    const ro = (await (await handle(api(cookie, "POST", "/api/dev/keys", { name: "reader", scope: "read", expiresInDays: 1 }), env, deps)).json()) as { key: string; apiKey: { scope: string; expiresAt: string } };
    expect(ro.apiKey.scope).toBe("read");
    expect(ro.apiKey.expiresAt).toBe("2026-10-17T10:00:00.000Z");
    const auth = { Authorization: `Bearer ${ro.key}` };
    expect((await handle(api(null, "GET", `/api/dev/apps/${appId}`, undefined, auth), env, deps)).status).toBe(200);
    const denied = await handle(api(null, "PUT", `/api/dev/apps/${appId}`, { tagline: "x" }, auth), env, deps);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/read-only/);
    expect((await handle(api(null, "POST", `/api/dev/apps/${appId}/links`, { label: "x" }, auth), env, deps)).status).toBe(403);
    deps.advance(2 * 86_400_000);
    expect((await handle(api(null, "GET", `/api/dev/apps/${appId}`, undefined, auth), env, deps)).status).toBe(401);
    expect((await handle(api(cookie, "POST", "/api/dev/keys", { name: "bad", expiresInDays: 0 }), env, deps)).status).toBe(400);
    expect((await handle(api(cookie, "POST", "/api/dev/keys", { name: "bad", expiresInDays: 999 }), env, deps)).status).toBe(400);
  });

  it("revokes every key at once and logs it", async () => {
    const a = (await (await handle(api(cookie, "POST", "/api/dev/keys", { name: "a" }), env, deps)).json()) as { key: string };
    const b = (await (await handle(api(cookie, "POST", "/api/dev/keys", { name: "b" }), env, deps)).json()) as { key: string };
    expect(await (await handle(api(cookie, "POST", "/api/dev/keys/revoke-all"), env, deps)).json()).toEqual({ ok: true, revoked: 2 });
    expect((await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: `Bearer ${a.key}` }), env, deps)).status).toBe(401);
    expect((await handle(api(null, "GET", "/api/dev/me", undefined, { Authorization: `Bearer ${b.key}` }), env, deps)).status).toBe(401);
    const log = (await (await handle(api(cookie, "GET", "/api/dev/audit"), env, deps)).json()) as { events: { event: string; detail: string }[] };
    expect(log.events[0]).toMatchObject({ event: "api-keys-revoked-all", detail: "2 keys" });
    expect(log.events.some((e) => e.event === "api-key-created" && e.detail.startsWith("a (manage"))).toBe(true);
  });
});
