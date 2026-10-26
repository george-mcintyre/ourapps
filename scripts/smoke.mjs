// Live check of ourapps against a running deployment, the way an agent uses it.
// Usage: OURAPPS_API_KEY=oa_... node scripts/smoke.mjs [--base https://ourapps.app]
// Optional OURAPPS_READ_API_KEY checks that an owner's read-only key cannot save target selection.
// Without a key only the public part runs. With a manage key it walks every endpoint agents.md
// lists on a throwaway app, compares answers with the documented shapes, and deletes what it made.
// It never calls endpoints that change anything at Apple or GitHub.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = (baseAt >= 0 ? args[baseAt + 1] : "https://ourapps.app").replace(/\/$/, "");
const local = /^http:\/\/localhost(:\d+)?$/.test(base);
const key = process.env.OURAPPS_API_KEY ?? "";
const agentsMd = readFileSync(new URL("../site/public/agents.md", import.meta.url), "utf8");

const results = [];
const exercised = new Set();
let failures = 0;

function record(ok, name, detail = "") {
  results.push({ ok, name, detail });
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

// Records the call against the documented route pattern, then returns status, headers and parsed body.
async function call(method, path, { body, rawBody, auth = key, token, pattern } = {}) {
  exercised.add(`${method} ${pattern ?? path}`);
  const headers = { Accept: "application/json" };
  if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(base + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = method === "HEAD" ? "" : await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const has = (obj, keys) => keys.filter((k) => !(obj && k in obj));
function expectKeys(name, obj, keys) {
  const missing = has(obj, keys);
  record(missing.length === 0, name, missing.length ? `missing ${missing.join(", ")}` : "");
}
function expectStatus(name, res, status) {
  const ok = Array.isArray(status) ? status.includes(res.status) : res.status === status;
  record(ok, name, ok ? "" : `status ${res.status}, body ${res.text.slice(0, 160)}`);
}

// Documented endpoints: lines in agents.md code blocks that start with a method and an /api path.
function documentedEndpoints() {
  const out = new Set();
  for (const m of agentsMd.matchAll(/^(GET|POST|PUT|DELETE|HEAD)(?:,\s*(?:GET|POST|PUT|DELETE|HEAD))*\s+(\/api\/[^\s`]+)/gm)) out.add(`${m[1]} ${m[2]}`);
  for (const m of agentsMd.matchAll(/`(GET|POST|PUT|DELETE|HEAD)(?:\|(?:GET|HEAD))?\s+(\/api\/[^\s`]+)`/g)) out.add(`${m[1]} ${m[2]}`);
  return [...out].map((e) => e.replace(/\?.*$/, ""));
}

// The App object as agents.md lists it.
function documentedAppFields() {
  const m = agentsMd.match(/App object: `\{ ([^}]+) \}`/);
  return m ? m[1].split(",").map((f) => f.trim()) : [];
}

const targetKeys = ["ios", "android", "web", "macos", "windows", "tvos"];
const defaultTargets = Object.fromEntries(targetKeys.map((target) => [target, true]));

function expectTargets(name, res, expected) {
  expectStatus(name, res, 200);
  const targets = res.json?.targets;
  record(Object.keys(res.json ?? {}).length === 1 && targets !== null && typeof targets === "object"
    && Object.keys(targets).length === targetKeys.length
    && targetKeys.every((target) => typeof targets[target] === "boolean" && targets[target] === expected[target]), `${name} has exactly six expected booleans`);
  record(res.headers.get("cache-control") === "no-store", `${name} is not cached`);
}

async function targetChecks(id, buildToken, app, detail, listed) {
  const readPath = `/api/build/${id}/targets`;
  const read = (options = {}) => call("GET", readPath, { token: buildToken, pattern: "/api/build/:app/targets", ...options });
  const write = (target, options) => call("PUT", `/api/dev/apps/${id}/targets/${target}`, { pattern: "/api/dev/apps/:id/targets/:target", ...options });
  for (const [name, value] of [["created app", app], ["app detail", detail], ["app list", listed]]) {
    record(Object.keys(value?.targets ?? {}).length === 6 && targetKeys.every((target) => value?.targets?.[target] === true), `${name} defaults to six enabled targets`);
  }
  expectTargets("build-token target defaults", await read(), defaultTargets);
  for (const [name, options] of [["missing token", { auth: "", token: "" }], ["invalid token", { token: "0".repeat(48) }], ["developer key", { token: "" }]]) {
    expectStatus(`target read refuses ${name}`, await read(options), 401);
  }
  expectStatus("a build token cannot save targets", await write("tvos", { token: buildToken, body: { enabled: false } }), 401);
  const readKey = process.env.OURAPPS_READ_API_KEY;
  if (readKey) {
    const identity = await call("GET", "/api/dev/me", { auth: readKey });
    record(identity.status === 200 && identity.json?.scope === "read" && identity.json?.developer?.id === app.developerId, "optional read key belongs to the owner with read scope");
    expectStatus("a read-only key cannot save targets", await write("tvos", { auth: readKey, body: { enabled: false } }), 403);
  } else {
    console.log("pending read-only target write check: set OURAPPS_READ_API_KEY to an owner read key");
  }
  const sibling = await call("POST", "/api/dev/apps", { body: { name: "Poker Night scope check", repo: "george-mcintyre/ourapps-smoke-test", showOnPage: false } });
  expectStatus("create a second throwaway app for target token scope", sibling, 201);
  if (sibling.json?.app?.id) {
    const siblingId = sibling.json.app.id;
    try {
      record(typeof sibling.json.buildToken === "string" && sibling.json.buildToken.length > 0, "the scope-check app returns a build token");
      expectStatus("target reads refuse another app's token", await read({ token: sibling.json.buildToken }), 401);
      expectStatus("the target token cannot read another app", await call("GET", `/api/build/${siblingId}/targets`, { token: buildToken, pattern: "/api/build/:app/targets" }), 401);
    } finally {
      expectStatus("delete the scope-check app", await call("DELETE", `/api/dev/apps/${siblingId}`, { pattern: "/api/dev/apps/:id" }), 200);
    }
  }
  for (const target of targetKeys) {
    try {
      const disabled = { ...defaultTargets, [target]: false };
      expectTargets(`disable ${target}`, await write(target, { body: { enabled: false } }), disabled);
      expectTargets(`repeat disable ${target}`, await write(target, { body: { enabled: false } }), disabled);
      expectTargets(`read disabled ${target}`, await read(), disabled);
    } finally {
      expectTargets(`restore ${target}`, await write(target, { body: { enabled: true } }), defaultTargets);
    }
    expectTargets(`read restored ${target}`, await read(), defaultTargets);
  }
  const invalid = [undefined, null, [], true, {}, { enabled: "false" }, { enabled: 0 }, { enabled: null }, { enabled: false, extra: true }];
  for (const body of invalid) {
    expectStatus("target save refuses an invalid body", await write("tvos", { body }), 400);
    expectTargets("invalid save preserves targets", await read(), defaultTargets);
  }
  expectStatus("target save refuses malformed JSON", await write("tvos", { rawBody: "{" }), 400);
  expectStatus("target save refuses an unknown target", await write("unknown", { body: { enabled: false } }), 400);
  expectTargets("rejected saves preserve targets", await read(), defaultTargets);
}

async function publicChecks() {
  const health = await call("GET", "/api/health", { auth: "" });
  // Local runs have no GitHub sign-in configured.
  record(health.status === 200 && health.json?.ok === true && (local || health.json?.oauth) && health.json?.links && health.json?.secrets, "health reports every secret configured", JSON.stringify(health.json));
  for (const path of ["/agents.md", "/contract.md", "/llms.txt", "/free-tiers.md", "/web/install-banner.js", "/reference", "/terms"]) {
    const res = await fetch(base + path);
    record(res.status === 200, `GET ${path}`, res.status === 200 ? "" : String(res.status));
  }
  const unknown = await call("GET", "/api/public/links/000000000000000000000000", { auth: "", pattern: "/api/public/links/:id" });
  expectStatus("an unknown share link is a 404", unknown, 404);
  const noKey = await call("GET", "/api/dev/apps", { auth: "" });
  expectStatus("the dev API needs a key", noKey, 401);
  const badKey = await call("GET", "/api/dev/me", { auth: "oa_" + "0".repeat(40) });
  expectStatus("an unknown key is refused", badKey, 401);
}

async function keyedChecks() {
  const me = await call("GET", "/api/dev/me");
  expectStatus("GET /api/dev/me", me, 200);
  expectKeys("me shape", me.json, ["developer", "authVia", "scope", "termsVersion", "secrets"]);
  record(me.json?.authVia === "key", "me says the key is in use", me.json?.authVia);
  if (me.json?.scope !== "manage") {
    record(false, "the key has manage scope", `scope is ${me.json?.scope}; the walk needs a manage key`);
    return;
  }
  expectKeys("me.secrets shape", me.json.secrets, ["apple", "appleSavedAt", "appleTeamId", "appleTeamIdSavedAt", "github", "githubSavedAt", "signing"]);
  const { slug, displayName } = me.json.developer;
  const same = await call("PUT", "/api/dev/me", { body: { slug, displayName } });
  expectStatus("PUT /api/dev/me with the current values", same, 200);
  record(same.json?.developer?.slug === slug && same.json?.developer?.displayName === displayName, "the profile is unchanged");
  const devPage = await call("GET", `/api/public/dev/${encodeURIComponent(slug)}`, { auth: "", pattern: "/api/public/dev/:slug" });
  expectStatus("GET /api/public/dev/:slug", devPage, 200);
  expectKeys("developer page shape", devPage.json, ["developer", "apps"]);

  const list = await call("GET", "/api/dev/apps");
  expectStatus("GET /api/dev/apps", list, 200);
  record(Array.isArray(list.json?.apps), "apps is a list");

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const created = await call("POST", "/api/dev/apps", {
    body: { name: `Smoke test ${stamp}`, repo: "george-mcintyre/ourapps-smoke-test", tagline: "Created by scripts/smoke.mjs", screenshots: [], screenshotsByPlatform: { iphone: [], ipad: [], android: [], web: [] }, showOnPage: false },
  });
  expectStatus("POST /api/dev/apps", created, 201);
  const app = created.json?.app;
  const buildToken = created.json?.buildToken;
  record(typeof buildToken === "string" && buildToken.length === 48, "the build token is 48 hex characters", String(buildToken?.length));
  if (!app?.id) return;
  const id = app.id;
  const P = (s) => s.replace(":id", id);
  try {
    const fields = documentedAppFields();
    const actual = Object.keys(app);
    const missing = fields.filter((f) => !actual.includes(f));
    const extra = actual.filter((f) => !fields.includes(f));
    record(missing.length === 0 && extra.length === 0, "the App object matches agents.md", [missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `undocumented ${extra.join(", ")}` : ""].filter(Boolean).join("; "));

    const got = await call("GET", P("/api/dev/apps/:id"), { pattern: "/api/dev/apps/:id" });
    expectStatus("GET /api/dev/apps/:id", got, 200);
    expectKeys("app detail shape", got.json, ["app", "links"]);
    const targetList = await call("GET", "/api/dev/apps");
    expectStatus("list the throwaway app's targets", targetList, 200);
    await targetChecks(id, buildToken, app, got.json?.app, targetList.json?.apps?.find((item) => item.id === id));
    const distribution = await call("GET", `/api/build/${id}/tvos/testflight/distribution`, { auth: buildToken, pattern: "/api/build/:app/:platform/testflight/distribution" });
    expectStatus("distribution status requires configured platform setup", distribution, 409);

    const bad = await call("PUT", P("/api/dev/apps/:id"), { body: { bundleId: "not a bundle id" }, pattern: "/api/dev/apps/:id" });
    expectStatus("a malformed bundle ID is refused", bad, 400);
    const updated = await call("PUT", P("/api/dev/apps/:id"), { body: { tagline: "Updated by the smoke check", screenshotsByPlatform: { web: ["https://example.com/shot.png"] } }, pattern: "/api/dev/apps/:id" });
    expectStatus("PUT /api/dev/apps/:id", updated, 200);
    record(updated.json?.app?.tagline === "Updated by the smoke check" && updated.json?.app?.screenshotsByPlatform?.web?.length === 1, "the update is returned");

    const release = await call("GET", P("/api/dev/apps/:id/release"), { pattern: "/api/dev/apps/:id/release" });
    expectStatus("GET /api/dev/apps/:id/release", release, 200);
    expectKeys("release status shape", release.json, ["ok", "githubToken", "appleKey", "tag", "publishedAt", "assets", "manifestUrl", "version", "install", "web", "screenshots", "changelog", "errors"]);
    record(release.json?.ok === false && release.json?.errors?.length > 0, "a missing repository is reported in plain words", release.json?.errors?.[0]);

    const preview = await call("GET", P("/api/dev/apps/:id/preview"), { pattern: "/api/dev/apps/:id/preview" });
    expectStatus("GET /api/dev/apps/:id/preview", preview, 200);
    expectKeys("preview shape", preview.json, ["developer", "app", "release", "releaseError", "history", "screenshots", "preview"]);

    const link = await call("POST", P("/api/dev/apps/:id/links"), { body: { label: "smoke check" }, pattern: "/api/dev/apps/:id/links" });
    expectStatus("POST /api/dev/apps/:id/links", link, 201);
    expectKeys("link shape", link.json, ["link", "url"]);
    const linkId = link.json?.link?.id;
    if (linkId) {
      const L = (s) => s.replace(":id", linkId);
      const page = await call("GET", L("/api/public/links/:id"), { auth: "", pattern: "/api/public/links/:id" });
      expectStatus("GET /api/public/links/:id", page, 200);
      expectKeys("public link page shape", page.json, ["linkId", "developer", "app", "release", "releaseError", "history", "screenshots"]);
      record(!page.text.includes("ourapps-smoke-test"), "the public link data does not name the repository", page.json?.releaseError);
      const qr = await fetch(base + L("/api/public/links/:id/qr.svg"));
      exercised.add("GET /api/public/links/:id/qr.svg");
      record(qr.status === 200 && (qr.headers.get("content-type") ?? "").includes("svg"), "GET /api/public/links/:id/qr.svg", String(qr.status));
      const latest = await call("GET", L("/api/public/links/:id/latest"), { auth: "", pattern: "/api/public/links/:id/latest" });
      record(latest.status === 503 && /no release/.test(latest.json?.error ?? ""), "GET /api/public/links/:id/latest says no release without naming the repository", `status ${latest.status} ${latest.text.slice(0, 120)}`);
      record(!latest.text.includes("ourapps-smoke-test"), "the update check does not leak the repository name");

      const renamed = await call("PUT", L("/api/dev/links/:id"), { body: { label: "smoke check renamed" }, pattern: "/api/dev/links/:id" });
      expectStatus("PUT /api/dev/links/:id", renamed, 200);
      record(renamed.json?.link?.label === "smoke check renamed" && renamed.json?.link?.id === linkId, "renaming keeps the address");
      const revoked = await call("POST", L("/api/dev/links/:id/revoke"), { pattern: "/api/dev/links/:id/revoke" });
      expectStatus("POST /api/dev/links/:id/revoke", revoked, 200);
      const gone = await call("GET", L("/api/public/links/:id"), { auth: "", pattern: "/api/public/links/:id" });
      expectStatus("a revoked link stops answering", gone, 410);
      const removed = await call("DELETE", L("/api/dev/links/:id"), { pattern: "/api/dev/links/:id" });
      expectStatus("DELETE /api/dev/links/:id", removed, 200);
    }

    const rotated = await call("POST", P("/api/dev/apps/:id/build-token"), { pattern: "/api/dev/apps/:id/build-token" });
    expectStatus("POST /api/dev/apps/:id/build-token", rotated, 200);
    const newToken = rotated.json?.buildToken;
    record(typeof newToken === "string" && /^[a-f0-9]{48}$/.test(newToken), "rotation returns a build token");
    const targetPath = `/api/build/${id}/targets`;
    const targetPattern = "/api/build/:app/targets";
    expectStatus("target reads refuse the rotated token", await call("GET", targetPath, { token: buildToken, pattern: targetPattern }), 401);
    expectTargets("target reads accept the replacement token", await call("GET", targetPath, { token: newToken, pattern: targetPattern }), defaultTargets);
    const oldRefused = await call("GET", P("/api/build/:id/signing"), { token: buildToken, pattern: "/api/build/:id/signing" });
    expectStatus("the old build token stops working", oldRefused, 401);
    const signingHead = await call("HEAD", P("/api/build/:id/signing"), { token: newToken, pattern: "/api/build/:id/signing" });
    expectStatus("HEAD /api/build/:id/signing before TestFlight is set up is a 404", signingHead, 404);
    const signing = await call("GET", P("/api/build/:id/signing"), { token: newToken, pattern: "/api/build/:id/signing" });
    record(signing.status === 404 && typeof signing.json?.error === "string", "GET /api/build/:id/signing explains why it is not ready", signing.json?.error);
    const upload = await call("POST", P("/api/build/:id/testflight/upload"), { token: newToken, body: { version: "0", buildNumber: "0", fileName: "x.ipa", fileSize: 1 }, pattern: "/api/build/:id/testflight/upload" });
    expectStatus("POST /api/build/:id/testflight/upload before TestFlight is set up is a 409", upload, 409);

    // The throwaway app has no bundle ID, so neither call reaches Apple.
    const tf = await call("GET", P("/api/dev/apps/:id/testflight"), { pattern: "/api/dev/apps/:id/testflight" });
    expectStatus("GET /api/dev/apps/:id/testflight", tf, 200);
    expectKeys("TestFlight shape", tf.json, ["setUp", "needs", "storeApp", "stage", "url", "invitation", "buildRequest", "profile", "contact", "builds"]);
    record(tf.json?.setUp === false && tf.json?.needs === "bundle-id", "a new app needs its bundle ID first", tf.json?.needs);
    const tfSetUp = await call("POST", P("/api/dev/apps/:id/testflight"), { pattern: "/api/dev/apps/:id/testflight" });
    record(tfSetUp.status === 200 && tfSetUp.json?.needs === "bundle-id", "POST /api/dev/apps/:id/testflight names the missing bundle ID", `${tfSetUp.status} ${tfSetUp.json?.needs}`);
    const tfBuild = await call("POST", P("/api/dev/apps/:id/testflight/build"), { pattern: "/api/dev/apps/:id/testflight/build" });
    expectStatus("POST /api/dev/apps/:id/testflight/build before set-up is a 409", tfBuild, 409);
    // An empty contact is refused, so the saved one is never touched.
    const contact = await call("PUT", "/api/dev/review-contact", { body: { firstName: "", lastName: "", email: "", phone: "" } });
    expectStatus("PUT /api/dev/review-contact refuses an empty contact", contact, 400);

    const keys = await call("GET", "/api/dev/keys");
    expectStatus("GET /api/dev/keys", keys, 200);
    const k = keys.json?.keys?.[0];
    record(Array.isArray(keys.json?.keys) && k && !("keyHash" in k) && "prefix" in k, "keys list prefixes, never hashes");
    const audit = await call("GET", "/api/dev/audit");
    expectStatus("GET /api/dev/audit", audit, 200);

    // Browser-only actions must refuse a key.
    for (const [method, path, body] of [["POST", "/api/dev/keys", { name: "x" }], ["PUT", "/api/dev/secrets", {}], ["POST", "/api/dev/signing", {}], ["DELETE", "/api/dev/me", {}], ["POST", "/api/dev/keys/revoke-all", undefined]]) {
      const pattern = path.replace(id, ":id");
      const r = await call(method, path, { body, pattern });
      expectStatus(`${method} ${pattern} refuses an API key`, r, 403);
    }
  } finally {
    const del = await call("DELETE", P("/api/dev/apps/:id"), { pattern: "/api/dev/apps/:id" });
    expectStatus("DELETE /api/dev/apps/:id (cleanup)", del, 200);
    const after = await call("GET", P("/api/dev/apps/:id"), { pattern: "/api/dev/apps/:id" });
    expectStatus("the deleted app is gone", after, 404);
  }
}

function coverage() {
  const normalise = (e) => e.replace(/:[a-zA-Z]+/g, ":id");
  const done = new Set([...exercised].map(normalise));
  const documented = documentedEndpoints().map(normalise);
  const notWalked = documented.filter((e) => !done.has(e));
  record(notWalked.length === 0, "every endpoint agents.md lists was called", notWalked.join(", "));
}

console.log(`ourapps live check against ${base}${key ? "" : " (public part only; set OURAPPS_API_KEY for the rest)"}`);
await publicChecks();
if (key) {
  await keyedChecks();
  coverage();
}
console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
