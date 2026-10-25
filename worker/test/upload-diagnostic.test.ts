import { beforeEach, describe, expect, it } from "vitest";
import { Db, type AppRow } from "../src/db.js";
import { sha256Hex } from "../src/crypto.js";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { saveSecrets } from "../src/secrets.js";
import { sanitiseUploadFile } from "../src/upload-diagnostic.js";
import { api, applePem, clearDb, createSkull, fakeFetch, githubRoutes, jsonRes, signIn, testDeps, testEnv, type TestDeps } from "./helpers.js";

const fileId = "3339b443-54b2-4b5a-9cb0-57546ca6ec5f";
const upstream = `GET api.appstoreconnect.apple.com/v1/buildUploadFiles/${fileId}`;
const secret = "PRIVATE_VALUE_NOT_FOR_DIAGNOSTICS";
let env: Env;
let deps: TestDeps;
let app: AppRow;
let token: string;
let cookie: string;

function request(platform = "macos", id = app.id, file = fileId, bearer = token) {
  return api(null, "GET", `/api/build/${id}/${platform}/testflight/upload/${file}/status`, undefined, bearer ? { Authorization: `Bearer ${bearer}` } : {});
}

function attributes() {
  return { fileSize: "10", uploaded: false, assetToken: secret, fileName: secret, sourceFileChecksums: { value: secret }, state: secret,
    assetDeliveryState: { state: "AWAITING_UPLOAD", errors: [{ description: secret }], warnings: [{ description: secret }] },
    uploadOperations: [
      { method: "PUT", offset: "5", length: 5, url: `https://user:${secret}@upload.example.test/private/${secret}?signature=${secret}#${secret}`, requestHeaders: [{ name: "Authorization", value: secret }, { name: "X-Amz-Security-Token", value: secret }, { name: `invalid ${secret}`, value: secret }] },
      { method: "PUT", offset: 0, length: "5", url: `https://upload.example.test/another/${secret}?signature=${secret}`, requestHeaders: [] },
    ],
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
  await Db.from(env).insertTestflightBuild({ appId: app.id, platform: "macos", version: "0.5.0", buildNumber: "3", uploadId: "upload", uploadFileId: fileId, buildId: null, whatsNew: null, state: "uploading", message: null, createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
});

describe("read-only upload-file diagnostic", () => {
  it("reports the documented shape and numeric types without secrets or URL components", async () => {
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: attributes() } }) });
    const before = await Db.from(env).testflightBuild(app.id, fileId, "macos");
    const blob = await Db.from(env).secretsBlob(app.developerId);
    const response = await handle(request(), env, { ...deps, fetch: (input, init) => {
      expect(init?.redirect).toBe("manual");
      return stub.fetch(input, init);
    } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain(token);
    expect(body).not.toContain("https://");
    expect(body).not.toContain("/private/");
    expect(body).not.toContain("assetToken");
    expect(body).not.toContain("sourceFileChecksums");
    const data = JSON.parse(body);
    expect(data).toMatchObject({ platform: "macos", version: "0.5.0", buildNumber: "3", uploadFileId: fileId, recordedState: "uploading",
      appleFile: { assetDeliveryState: "AWAITING_UPLOAD", uploaded: false, fileSize: "10", fileSizeType: "string", operationCount: 2,
        coverage: { expectedFileSize: 10, fileSizeValid: true, numericValid: true, sortedContiguous: true, originalOrderContiguous: false, nonOverlapping: true, coveredBytes: 10, complete: true } } });
    expect(data.appleFile.operations[0]).toEqual({ method: "PUT", offset: "5", length: 5, types: { method: "string", offset: "string", length: "number", url: "string", requestHeaders: "array" }, https: true, hostname: "upload.example.test", headerNames: ["Authorization", "X-Amz-Security-Token", "invalid"], headerNamesTruncated: false });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toBe(`https://api.appstoreconnect.apple.com/v1/buildUploadFiles/${fileId}`);
    expect(await Db.from(env).testflightBuild(app.id, fileId, "macos")).toEqual(before);
    expect(await Db.from(env).secretsBlob(app.developerId)).toBe(blob);
  });

  it.each(["", "wrong-token"])("rejects missing or invalid authentication before any Apple inspection", async (bearer) => {
    const stub = fakeFetch({});
    const response = await handle(request("macos", app.id, fileId, bearer), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects another app's build token", async () => {
    const other = await createSkull(env, deps, cookie);
    const stub = fakeFetch({});
    expect((await handle(request("macos", app.id, fileId, other.buildToken), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it.each(["tvos", "ios"])("does not inspect a macos upload from platform %s", async (platform) => {
    const stub = fakeFetch({});
    expect((await handle(request(platform), env, { ...deps, fetch: stub.fetch })).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects a file belonging to another app and an unknown file without Apple calls", async () => {
    const other = await createSkull(env, deps, cookie);
    const stub = fakeFetch({});
    expect((await handle(request("macos", other.appId, fileId, other.buildToken), env, { ...deps, fetch: stub.fetch })).status).toBe(404);
    expect((await handle(request("macos", app.id, "missing-file"), env, { ...deps, fetch: stub.fetch })).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([302, 401, 403, 404, 500])("returns only sanitized Apple status for upstream %s", async (status) => {
    const stub = fakeFetch({ [upstream]: () => jsonRes({ errors: [{ detail: `${secret} https://secret.invalid/path?token=${secret}` }] }, status) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Apple upload-file lookup failed", appleStatus: status });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects malformed or mismatched Apple resources without exposing their contents", async () => {
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: secret, type: "buildUploadFiles", attributes: attributes() } }) });
    const response = await handle(request(), env, { ...deps, fetch: stub.fetch });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Apple upload-file lookup failed", appleStatus: 502 });
  });

  it("keeps legacy token hashes unchanged during authentication", async () => {
    const legacy = await sha256Hex(token);
    await env.DB.prepare("UPDATE apps SET build_token_hash = ? WHERE id = ?").bind(legacy, app.id).run();
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: {} } }) });
    expect((await handle(request(), env, { ...deps, fetch: stub.fetch })).status).toBe(200);
    expect((await Db.from(env).appById(app.id))!.buildTokenHash).toBe(legacy);
  });

  it("reads previous-key credentials without rewrapping them or rewriting the app token", async () => {
    const rotated = { ...env, MASTER_KEY: "diagnostic-test-current-master-key", MASTER_KEY_PREVIOUS: env.MASTER_KEY };
    const blob = await Db.from(env).secretsBlob(app.developerId);
    const hash = (await Db.from(env).appById(app.id))!.buildTokenHash;
    const stub = fakeFetch({ [upstream]: () => jsonRes({ data: { id: fileId, type: "buildUploadFiles", attributes: {} } }) });
    expect((await handle(request(), rotated, { ...deps, fetch: stub.fetch })).status).toBe(200);
    expect(await Db.from(env).secretsBlob(app.developerId)).toBe(blob);
    expect((await Db.from(env).appById(app.id))!.buildTokenHash).toBe(hash);
  });

  it("authenticates before checking an unknown file or platform", async () => {
    const stub = fakeFetch({});
    expect((await handle(request("unknown", app.id, "missing", "wrong"), env, { ...deps, fetch: stub.fetch })).status).toBe(401);
    expect((await handle(request("unknown"), env, { ...deps, fetch: stub.fetch })).status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("diagnostic coverage", () => {
  it("keeps absent operations and undocumented fields unknown", () => {
    const data = sanitiseUploadFile({ state: secret, assetToken: secret });
    expect(data).toMatchObject({ assetDeliveryState: null, fileSize: null, fileSizeType: "missing", operationCount: null,
      coverage: { expectedFileSize: null, fileSizeValid: null, numericValid: null, sortedContiguous: null, nonOverlapping: null, originalOrderContiguous: null, coveredBytes: null, complete: null } });
    expect(data).not.toHaveProperty("uploaded");
  });

  it.each([
    [[{ offset: 0, length: "5" }, { offset: "5", length: 5 }], true, true, 10, true],
    [[{ offset: 0, length: 6 }, { offset: 5, length: 5 }], false, false, 10, false],
    [[{ offset: 0, length: 4 }, { offset: 5, length: 5 }], false, true, 9, false],
  ])("distinguishes contiguous, overlapping and missing ranges", (uploadOperations, contiguous, nonOverlapping, coveredBytes, complete) => {
    expect(sanitiseUploadFile({ fileSize: 10, uploadOperations }).coverage).toMatchObject({ numericValid: true, sortedContiguous: contiguous, nonOverlapping, coveredBytes, complete });
  });

  it.each([undefined, "invalid", 0, "0"])("keeps missing or invalid file size %s unknown", (fileSize) => {
    expect(sanitiseUploadFile({ fileSize, uploadOperations: [{ offset: 0, length: 5 }] }).coverage).toMatchObject({ expectedFileSize: null, complete: null, numericValid: true, coveredBytes: 5 });
  });

  it.each(["not numeric", "5e2", -1, 1.5, 9007199254740992])("reports invalid ranges safely for %s", (length) => {
    const data = sanitiseUploadFile({ fileSize: 10, uploadOperations: [{ offset: 0, length }] });
    expect(data.coverage).toMatchObject({ numericValid: false, sortedContiguous: null, nonOverlapping: null, originalOrderContiguous: null, coveredBytes: null, complete: null });
  });

  it("bounds operation/header output and omits unverified state and uploaded values", () => {
    const data = sanitiseUploadFile({ assetDeliveryState: { state: secret }, uploaded: secret, fileSize: secret, uploadOperations: Array.from({ length: 200 }, () => ({ method: `PUT ${secret}`, offset: 0, length: 1, url: `not a URL ${secret}`, requestHeaders: Array.from({ length: 50 }, () => ({ name: `bad ${secret}`, value: secret })) })) });
    expect(data.operationCount).toBe(200);
    expect(data.operations).toHaveLength(128);
    expect(data.operationsTruncated).toBe(true);
    expect(data.operations[0]).toMatchObject({ method: null, https: false, hostname: null, headerNamesTruncated: true });
    expect(data.operations[0]!.headerNames).toHaveLength(32);
    expect(data.coverage.numericValid).toBeNull();
    expect(data.assetDeliveryState).toBeNull();
    expect(data).not.toHaveProperty("uploaded");
    expect(JSON.stringify(data)).not.toContain(secret);
  });
});
