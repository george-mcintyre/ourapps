import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { saveSecrets } from "../src/secrets.js";
import { api, applePem, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

const fileId = "3339b443-54b2-4b5a-9cb0-57546ca6ec5f";
const upstream = `GET api.appstoreconnect.apple.com/v1/buildUploadFiles/${fileId}`;
const secret = "PRIVATE_SIGNED_UPLOAD_VALUE";
let env: Env;
let deps: TestDeps;
let app: AppRow;
let buildToken: string;
let cookie: string;

function attributes(): Record<string, unknown> {
  return { assetDeliveryState: { state: "AWAITING_UPLOAD" }, uploaded: false, fileSize: "50", uploadOperations: [20, 0, 40, 10, 30].map((offset) => ({
    method: "PUT", url: `https://upload.example.test/part/${offset}?signature=${secret}`, offset: String(offset), length: "10", entityTag: "OMIT_EXTRA_FIELD", requestHeaders: [{ name: "X-Signed-Header", value: secret, extra: "OMIT_EXTRA_FIELD" }],
  })) };
}

function request(body: unknown = { version: "0.5.0", buildNumber: "3", fileSize: 50 }, token = buildToken, platform = "macos", id = app.id, file = fileId) {
  return api(null, "POST", `/api/build/${id}/${platform}/testflight/upload/${file}/operations`, body, token ? { Authorization: `Bearer ${token}` } : {});
}

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
  const made = await createSkull(env, deps, cookie);
  buildToken = made.buildToken;
  app = (await Db.from(env).appById(made.appId))!;
  await saveSecrets(env, app.developerId, { appleIssuerId: "issuer", appleKeyId: "key", applePrivateKey: await applePem() }, deps.now());
  await Db.from(env).insertTestflightBuild({ appId: app.id, platform: "macos", version: "0.5.0", buildNumber: "3", uploadId: "existing-upload", uploadFileId: fileId, buildId: null, whatsNew: null, state: "uploading", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
});

afterEach(() => { vi.restoreAllMocks(); });

describe("existing-upload operation retrieval", () => {
  it("requires HTTPS before reading existing operations", async () => {
    const secure = request();
    const plain = new Request(secure.url.replace("https:", "http:"), { method: "POST", headers: secure.headers, body: await secure.text() });
    const stub = fakeFetch({});
    expect((await handle(plain, env, { ...deps, fetch: stub.fetch })).status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it("accepts five unsorted PUT parts, preserves signed fields and order, and performs no writes", async () => {
    const rotated = { ...env, MASTER_KEY: "upload-operation-current-master-key", MASTER_KEY_PREVIOUS: env.MASTER_KEY };
    const row = await Db.from(env).testflightBuild(app.id, fileId, "macos");
    const blob = await Db.from(env).secretsBlob(app.developerId);
    const hash = (await Db.from(env).appById(app.id))!.buildTokenHash;
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const cache = vi.spyOn(caches, "open");
    const put = vi.spyOn(env.WEBAPP_FILES, "put");
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: attributes() } }) });
    const response = await handle(request(), rotated, { ...deps, fetch: (input, init) => {
      expect(init?.redirect).toBe("manual");
      return stub.fetch(input, init);
    } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { operations: { offset: number; length: number; method: string; url: string; requestHeaders: { name: string; value: string }[] }[] };
    expect(Object.keys(body).sort()).toEqual(["buildNumber", "fileSize", "operations", "platform", "uploadFileId", "version"]);
    expect(body).toMatchObject({ platform: "macos", version: "0.5.0", buildNumber: "3", fileSize: 50, uploadFileId: fileId });
    expect(body.operations.map((op) => op.offset)).toEqual([20, 0, 40, 10, 30]);
    expect(body.operations[0]).toEqual({ method: "PUT", url: `https://upload.example.test/part/20?signature=${secret}`, offset: 20, length: 10, requestHeaders: [{ name: "X-Signed-Header", value: secret }] });
    expect(JSON.stringify(body)).not.toContain("OMIT_EXTRA_FIELD");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("GET");
    expect(await Db.from(env).testflightBuild(app.id, fileId, "macos")).toEqual(row);
    expect(await Db.from(env).secretsBlob(app.developerId)).toBe(blob);
    expect((await Db.from(env).appById(app.id))!.buildTokenHash).toBe(hash);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM build_number_reservations").first()).toEqual({ count: 0 });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["", "wrong"])("rejects missing or invalid app authentication", async (token) => {
    const stub = fakeFetch({});
    expect((await handle(request(undefined, token), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects cross-app tokens and scoped files", async () => {
    const other = await createSkull(env, deps, cookie);
    const stub = fakeFetch({});
    expect((await handle(request(undefined, other.buildToken), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect((await handle(request(undefined, other.buildToken, "macos", other.appId), env, { ...deps, fetch: stub.fetch })).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it.each(["ios", "tvos"])("rejects a Mac file under %s", async (platform) => {
    const stub = fakeFetch({});
    expect((await handle(request(undefined, buildToken, platform), env, { ...deps, fetch: stub.fetch })).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([null, {}, { version: "0.5.0", buildNumber: "3", fileSize: "50" }, { version: "0.5.0", buildNumber: 3, fileSize: 50 }, { version: "0.5.0", buildNumber: "3", fileSize: 0 }, { version: "0.5.0", buildNumber: "3", fileSize: 1.5 }, { version: "0.5.0", buildNumber: "3", fileSize: 9007199254740992 }])("rejects invalid body %j before reading Apple", async (body) => {
    const stub = fakeFetch({});
    expect((await handle(request(body), env, { ...deps, fetch: stub.fetch })).status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([{ version: "0.6.0", buildNumber: "3", fileSize: 50 }, { version: "0.5.0", buildNumber: "4", fileSize: 50 }])("rejects an existing-record identity mismatch", async (body) => {
    const stub = fakeFetch({});
    const response = await handle(request(body), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(409);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects local records outside uploading", async () => {
    await env.DB.prepare("UPDATE testflight_builds SET state = 'uploaded' WHERE app_id = ?").bind(app.id).run();
    const stub = fakeFetch({});
    expect((await handle(request(), env, { ...deps, fetch: stub.fetch })).status).toBe(409);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([{ fileSize: 51 }, { fileSize: null }, { uploaded: true }, { uploaded: "true" }, { assetDeliveryState: { state: "UPLOAD_COMPLETE" } }, { assetDeliveryState: { state: "FAILED" } }])("rejects mismatched Apple state or size", async (override) => {
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: { ...attributes(), ...override } } }) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("https://");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it.each(["gap", "overlap", "bounds", "empty", "too-many", "method", "http", "userinfo", "header-name", "header-value", "header-type", "unsafe-number", "invalid-numeric-string"])("rejects invalid Apple operations: %s", async (failure) => {
    const a = attributes();
    const operations = a.uploadOperations as Record<string, unknown>[];
    if (failure === "gap") operations.pop();
    if (failure === "overlap") operations[0]!.offset = 19;
    if (failure === "bounds") operations[0]!.length = 100;
    if (failure === "empty") a.uploadOperations = [];
    if (failure === "too-many") a.uploadOperations = Array(129).fill(operations[0]);
    if (failure === "method") operations[0]!.method = "PATCH";
    if (failure === "http") operations[0]!.url = `http://upload.example.test/?${secret}`;
    if (failure === "userinfo") operations[0]!.url = `https://user:${secret}@upload.example.test/object`;
    if (failure === "header-name") operations[0]!.requestHeaders = [{ name: `bad ${secret}`, value: secret }];
    if (failure === "header-value") operations[0]!.requestHeaders = [{ name: "X-Test", value: `value\r\n${secret}` }];
    if (failure === "header-type") operations[0]!.requestHeaders = [{ name: "X-Test", value: 1 }];
    if (failure === "unsafe-number") operations[0]!.offset = 9007199254740992;
    if (failure === "invalid-numeric-string") operations[0]!.length = "1e1";
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: a } }) });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Apple upload operations are invalid." });
    expect(JSON.stringify(logger.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("https://");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it.each([302, 403, 500])("sanitizes Apple read failure %s", async (status) => {
    const stub = fakeFetch({ [upstream]: () => jsonRes({ errors: [{ detail: `https://private.invalid/?token=${secret}` }] }, status) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Apple upload-file lookup failed", appleStatus: status });
    expect(stub.calls).toHaveLength(1);
  });
});
