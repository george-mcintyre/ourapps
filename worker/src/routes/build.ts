// Routes an app repo's CI calls with its per-app build token.
import { masterKeys } from "../auth.js";
import { hashMatches, tokenHash } from "../crypto.js";
import { Db, type AppRow } from "../db.js";
import type { Deps, Env } from "../env.js";
import { HttpError, bearer, json, readJson } from "../http.js";
import { loadSecrets } from "../secrets.js";
import { commitUpload, reservePlatformBuild, reserveUpload } from "../testflight.js";
import { applePlatform, profileType } from "../apple-platform.js";
import { parseBuildRunMetadata } from "../github.js";
import { AppleError } from "../apple.js";
import { appleClient } from "../flow.js";
import { sanitiseUploadFile } from "../upload-diagnostic.js";
import { uploadInteger, validateExistingUploadOperations } from "../upload-operations.js";

// Verifies the per-app token; a token stored as a plain hash is rewritten as a keyed hash.
async function requireBuildToken(request: Request, env: Env, app: AppRow, rehash = true): Promise<void> {
  const given = bearer(request);
  if (!given) throw new HttpError(401, "unauthorised");
  const match = await hashMatches(masterKeys(env), "build-token", given, app.buildTokenHash);
  if (!match.ok) throw new HttpError(401, "unauthorised");
  if (match.rewrite && rehash) await Db.from(env).rehashBuildToken(app.id, await tokenHash(masterKeys(env), "build-token", given));
}

export async function buildUploadFileStatus(request: Request, env: Env, deps: Deps, appId: string, platformName: string, fileId: string): Promise<Response> {
  const db = Db.from(env);
  const app = await db.appById(appId);
  if (!app) throw new HttpError(404, "unknown app");
  await requireBuildToken(request, env, app, false);
  const platform = applePlatform(platformName);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new HttpError(404, "unknown upload file");
  const row = await db.testflightBuild(app.id, fileId, platform);
  if (!row) throw new HttpError(404, "unknown upload file");
  try {
    const secrets = await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"], false);
    const attributes = await appleClient(env, deps, secrets).readBuildUploadFile(fileId);
    return json({ platform, version: /^\d+(?:\.\d+){0,2}$/.test(row.version) && row.version.length <= 32 ? row.version : "invalid",
      buildNumber: /^\d+$/.test(row.buildNumber) && row.buildNumber.length <= 32 ? row.buildNumber : "invalid", uploadFileId: fileId,
      recordedState: /^[a-z-]{1,32}$/.test(row.state) ? row.state : "invalid", appleFile: sanitiseUploadFile(attributes) });
  } catch (error) {
    return json({ error: "Apple upload-file lookup failed", appleStatus: error instanceof AppleError ? error.status : null }, 502);
  }
}

export async function buildUploadFileOperations(request: Request, env: Env, deps: Deps, appId: string, platformName: string, fileId: string): Promise<Response> {
  if (new URL(request.url).protocol !== "https:") throw new HttpError(400, "Upload operation retrieval requires HTTPS.");
  const db = Db.from(env);
  const app = await db.appById(appId);
  if (!app) throw new HttpError(404, "unknown app");
  await requireBuildToken(request, env, app, false);
  const platform = applePlatform(platformName);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new HttpError(404, "unknown upload file");
  const row = await db.testflightBuild(app.id, fileId, platform);
  if (!row) throw new HttpError(404, "unknown upload file");
  const body = await readJson<unknown>(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "version, buildNumber and a positive safe-integer fileSize are required.");
  const input = body as Record<string, unknown>;
  if (typeof input.version !== "string" || !input.version || input.version.length > 64 || typeof input.buildNumber !== "string" || !input.buildNumber || input.buildNumber.length > 64 || typeof input.fileSize !== "number" || !Number.isSafeInteger(input.fileSize) || input.fileSize <= 0) throw new HttpError(400, "version, buildNumber and a positive safe-integer fileSize are required.");
  if (row.state !== "uploading" || input.version !== row.version || input.buildNumber !== row.buildNumber) throw new HttpError(409, "Existing upload identity or recorded state does not match the request.");
  let attributes: unknown;
  try {
    const secrets = await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"], false);
    attributes = await appleClient(env, deps, secrets).readBuildUploadFile(fileId);
  } catch (error) {
    return json({ error: "Apple upload-file lookup failed", appleStatus: error instanceof AppleError ? error.status : null }, 502);
  }
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) throw new HttpError(502, "Apple upload-file response is invalid.");
  const file = attributes as Record<string, unknown>;
  const delivery = file.assetDeliveryState;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery) || (delivery as Record<string, unknown>).state !== "AWAITING_UPLOAD" || (file.uploaded !== undefined && file.uploaded !== false) || uploadInteger(file.fileSize, 1) !== input.fileSize) throw new HttpError(409, "Apple upload state or file size does not match the request.");
  const operations = validateExistingUploadOperations(file.uploadOperations, input.fileSize);
  return json({ platform, version: row.version, buildNumber: row.buildNumber, fileSize: input.fileSize, uploadFileId: fileId, operations });
}

// GET or HEAD /api/build/:app/signing - everything an iPhone build needs: ourapps' certificate, its
// private key and the app's App Store profile. 404 until signing and TestFlight are set up; HEAD
// answers the same status without the key.
export async function buildSigning(request: Request, env: Env, appId: string, platformName?: string): Promise<Response> {
  const platform = applePlatform(platformName ?? "ios");
  const db = Db.from(env);
  const base = await db.appById(appId);
  if (!base) throw new HttpError(404, "unknown app");
  const app = await db.platformApp(base, platform);
  await requireBuildToken(request, env, app);
  const certificate = await db.signingCertificate(app.developerId);
  if (!certificate) throw new HttpError(404, "iPhone signing is not set up; the developer sets it up under Settings in ourapps");
  if (!app.storeProfileBase64 || !app.storeProfileUuid) throw new HttpError(404, "TestFlight is not set up yet; the developer sets it up on the app's page in ourapps");
  const installer = platform === "macos" ? await db.signingCertificate(app.developerId, true) : null;
  const secrets = await loadSecrets(env, app.developerId, platform === "macos" ? ["signingKey", "appleTeamId", "installerSigningKey"] : ["signingKey", "appleTeamId"]);
  if (!secrets.signingKey) throw new HttpError(404, "the signing key is missing; set up iPhone signing again under Settings");
  if (platform === "macos" && (!installer || !secrets.installerSigningKey)) throw new HttpError(404, "Mac installer signing is not set up; run macos TestFlight setup");
  for (const cert of [certificate, installer]) if (cert?.expirationDate && Date.parse(cert.expirationDate) <= Date.now()) throw new HttpError(409, "signing certificate has expired; run signing setup again");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  return json({
    certificate: { id: certificate.certificateId, name: certificate.name, serialNumber: certificate.serialNumber, expirationDate: certificate.expirationDate, base64: certificate.certificateBase64 },
    privateKeyPem: secrets.signingKey,
    teamId: secrets.appleTeamId ?? null,
    storeProfile: { profileName: app.storeProfileName, profileId: app.storeProfileId, uuid: app.storeProfileUuid, profileBase64: app.storeProfileBase64 },
    testflight: { url: app.testflightUrl ?? null },
    ...(platformName ? {
      platform,
      profileType: profileType(platform, app.nativeMac),
      upload: { fileExtension: platform === "macos" ? ".pkg" : ".ipa", uti: platform === "macos" ? "com.apple.pkg" : "com.apple.ipa" },
      exportOptions: {
        method: "app-store-connect",
        signingStyle: "manual",
        signingCertificate: certificate.name,
        teamID: secrets.appleTeamId ?? null,
        provisioningProfiles: { [app.bundleId]: app.storeProfileName },
        ...(installer ? { installerSigningCertificate: installer.name } : {}),
      },
    } : {}),
    ...(installer ? { installerCertificate: { id: installer.certificateId, name: installer.name, serialNumber: installer.serialNumber, expirationDate: installer.expirationDate, base64: installer.certificateBase64 }, installerPrivateKeyPem: secrets.installerSigningKey } : {}),
  });
}

// Build-token TestFlight uploads, commits and Mac/TV build-number reservations.
export async function buildTestflight(request: Request, env: Env, deps: Deps, appId: string, step: "upload" | "commit" | "reserve-build", platformName = "ios"): Promise<Response> {
  const platform = applePlatform(platformName);
  if (step === "reserve-build" && platform === "ios") throw new HttpError(400, "Build-number reservation supports macos and tvos only; ios reservation is unsupported.");
  const db = Db.from(env);
  const base = await db.appById(appId);
  if (!base) throw new HttpError(404, "unknown app");
  const app = await db.platformApp(base, platform);
  await requireBuildToken(request, env, app);
  if (step === "reserve-build") {
    const raw = await request.text();
    let metadata: unknown;
    if (raw.trim()) {
      try { metadata = JSON.parse(raw); }
      catch { throw new HttpError(400, "Reservation metadata must be valid JSON."); }
    }
    return json(await reservePlatformBuild(env, deps, app, parseBuildRunMetadata(metadata)));
  }
  const body = await readJson<Record<string, unknown>>(request);
  return json(step === "upload" ? await reserveUpload(env, deps, app, body) : await commitUpload(env, deps, app, body));
}
