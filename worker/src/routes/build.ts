// Routes an app repo's CI calls with its per-app build token.
import { masterKeys } from "../auth.js";
import { hashMatches, tokenHash } from "../crypto.js";
import { Db, type AppRow } from "../db.js";
import type { Deps, Env } from "../env.js";
import { HttpError, bearer, json, readJson } from "../http.js";
import { loadSecrets } from "../secrets.js";
import { commitUpload, reservePlatformBuild, reserveUpload } from "../testflight.js";
import { applePlatform, profileType } from "../apple-platform.js";

// Verifies the per-app token; a token stored as a plain hash is rewritten as a keyed hash.
async function requireBuildToken(request: Request, env: Env, app: AppRow): Promise<void> {
  const given = bearer(request);
  if (!given) throw new HttpError(401, "unauthorised");
  const match = await hashMatches(masterKeys(env), "build-token", given, app.buildTokenHash);
  if (!match.ok) throw new HttpError(401, "unauthorised");
  if (match.rewrite) await Db.from(env).rehashBuildToken(app.id, await tokenHash(masterKeys(env), "build-token", given));
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
  if (step === "reserve-build") return json(await reservePlatformBuild(env, deps, app));
  const body = await readJson<Record<string, unknown>>(request);
  return json(step === "upload" ? await reserveUpload(env, deps, app, body) : await commitUpload(env, deps, app, body));
}
