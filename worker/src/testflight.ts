// TestFlight distribution: set-up per app, the upload the workflow makes through ourapps, and the
// scheduled step that puts each processed build in the friends' group and sends it for beta review.
import { AppleClient, AppleError } from "./apple.js";
import { Db, type AppRow, type BuildRunMetadata, type Developer, type DeveloperSecrets, type LinkState, type TestflightBuildRow, type VerifiedBuildRun } from "./db.js";
import type { Deps, Env } from "./env.js";
import { appleClient } from "./flow.js";
import { dispatchAppleWorkflow, dispatchEvent, fetchBuildManifest, GithubBuildRequestError, verifyBuildRun } from "./github.js";
import { HttpError } from "./http.js";
import { appleReady, loadSecrets, saveSecrets, secretsSummary } from "./secrets.js";
import { profileType } from "./apple-platform.js";
import { signingRequest } from "./signing.js";
import { loadManifest } from "./upstream.js";
import { BuildNumberError } from "./build-number.js";
import { requireTarget, TargetDisabledError } from "./targets.js";

export const BETA_GROUP = "Friends (ourapps)";
// A build stops working 90 days after upload; a new one is asked for this long before.
export const REFRESH_DAYS = 14;

const clean = (s: string) => s.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const storeProfileName = (appName: string) => `${clean(appName) || "App"} App Store`;

export function reviewContact(dev: Developer): { firstName: string; lastName: string; email: string; phone: string } | null {
  if (!dev.reviewFirstName || !dev.reviewLastName || !dev.reviewEmail || !dev.reviewPhone) return null;
  return { firstName: dev.reviewFirstName, lastName: dev.reviewLastName, email: dev.reviewEmail, phone: dev.reviewPhone };
}

// What stops TestFlight being set up, in the order the developer meets it. "store-app" is only known
// after asking Apple: the app record in App Store Connect, which Apple lets no one create through its API.
export type TestflightNeed = "bundle-id" | "apple-key" | "signing" | "review-contact" | "store-app";

export async function localNeed(env: Env, dev: Developer, app: AppRow): Promise<TestflightNeed | null> {
  if (!app.bundleId) return "bundle-id";
  const summary = await secretsSummary(env, dev.id);
  if (!appleReady(summary)) return "apple-key";
  if (!summary.signingKey || !(await Db.from(env).signingCertificate(dev.id))) return "signing";
  if (!reviewContact(dev)) return "review-contact";
  return null;
}

// What to type into App Store Connect's New App form: a name of 2 to 30 characters, unique on the App
// Store, so a second choice with the developer's name is offered for when the first is taken.
export function storeAppForm(app: AppRow, dev: Developer): { name: string; otherName: string; bundleId: string; sku: string } {
  const first = dev.displayName.trim().split(/\s+/)[0] || dev.githubLogin;
  const otherName = `${app.name} by ${first}`.slice(0, 30);
  return {
    name: app.name.trim().length >= 2 ? app.name.slice(0, 30) : otherName,
    otherName,
    bundleId: app.bundleId,
    sku: app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app",
  };
}

// Everything ourapps can do for TestFlight. Returns the next step only the developer can take, or null
// once the App Store profile, the friends' group and its public link exist.
export async function setUpTestflight(env: Env, deps: Deps, dev: Developer, app: AppRow): Promise<TestflightNeed | null> {
  const check = () => requireTarget(env, app);
  await check();
  const need = await localNeed(env, dev, app);
  if (need) return need;
  const db = Db.from(env);
  const contact = reviewContact(dev)!;
  const certificate = (await db.signingCertificate(dev.id))!;
  const apple = appleClient(env, deps, await loadSecrets(env, dev.id, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
  try {
    if (app.platform === "macos") await ensureInstallerSigning(env, deps, dev.id, apple, check);
    // Registered first, so the bundle ID is in App Store Connect's list when the developer adds the app.
    const bundleRes = await apple.ensureBundleId(app.bundleId, app.name, app.platform === "macos" && app.nativeMac, check);
    const store = await apple.findStoreApp(app.bundleId);
    if (!store) return "store-app";
    const name = platformProfileName(app);
    const profile = await apple.ensureStoreProfile(name, bundleRes, certificate.certificateId, profileType(app.platform ?? "ios", app.nativeMac), check);
    const group = await apple.ensureBetaGroup(store.id, app.platform && app.platform !== "ios" ? `${BETA_GROUP} ${app.platform}` : BETA_GROUP, check);
    await apple.setBetaReviewDetails(store.id, contact, "Shared privately with friends and family through ourapps.app. No sign-in is needed to use the app.", check);
    await apple.setBetaDescription(store.id, { description: app.description || app.tagline || app.name, feedbackEmail: contact.email }, check);
    await check();
    Object.assign(app, {
      ascAppId: store.id,
      betaGroupId: group.id,
      testflightUrl: group.publicLink ?? app.testflightUrl ?? null,
      storeProfileId: profile.id,
      storeProfileUuid: profile.uuid,
      storeProfileName: name,
      storeProfileBase64: profile.profileContent,
    });
    await db.setAppTestflight(app);
    return null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
}

const platformProfileName = (app: AppRow) => app.platform && app.platform !== "ios" ? `${storeProfileName(app.name)} ${app.platform}${app.nativeMac ? " native" : ""}` : storeProfileName(app.name);

export async function ensureInstallerSigning(env: Env, deps: Deps, developerId: string, apple: AppleClient, check?: () => Promise<void>): Promise<void> {
  const db = Db.from(env);
  const certificate = await db.signingCertificate(developerId, true);
  const summary = await secretsSummary(env, developerId);
  if (certificate && summary.installerSigningKey && (!certificate.expirationDate || Date.parse(certificate.expirationDate) > deps.now().getTime())) return;
  const generated = await signingRequest("ourapps Mac Installer");
  const secrets = await loadSecrets(env, developerId);
  secrets.installerSigningKey = generated.privateKey;
  secrets.savedAt = { ...secrets.savedAt, installerSigningKey: deps.now().toISOString() };
  const made = await apple.createDistributionCertificate(generated.csr, "MAC_INSTALLER_DISTRIBUTION", check);
  await saveSecrets(env, developerId, secrets, deps.now());
  await db.putSigningCertificate({ developerId, certificateId: made.id, name: made.name, serialNumber: made.serialNumber, certificateBase64: made.certificateContent, expirationDate: made.expirationDate, createdAt: deps.now().toISOString() }, true);
}

// After a new certificate, an app already on TestFlight gets its App Store profile made again with it.
export async function renewStoreProfile(env: Env, apple: AppleClient, app: AppRow, certificateId: string): Promise<void> {
  const check = () => requireTarget(env, app);
  await check();
  const bundleRes = await apple.ensureBundleId(app.bundleId, app.name, app.platform === "macos" && app.nativeMac, check);
  const name = platformProfileName(app);
  const profile = await apple.ensureStoreProfile(name, bundleRes, certificateId, profileType(app.platform ?? "ios", app.nativeMac), check);
  await check();
  Object.assign(app, { storeProfileId: profile.id, storeProfileUuid: profile.uuid, storeProfileName: name, storeProfileBase64: profile.profileContent });
  await Db.from(env).setAppTestflight(app);
}

// The workflow's upload: ourapps reserves it at Apple and returns where to send the bytes.
export async function reserveUpload(env: Env, deps: Deps, app: AppRow, body: { version?: unknown; buildNumber?: unknown; fileName?: unknown; fileSize?: unknown; whatsNew?: unknown }) {
  const check = () => requireTarget(env, app);
  await check();
  if (!app.ascAppId) throw new HttpError(409, "TestFlight is not set up for this app; the developer sets it up on the app's page in ourapps");
  const version = typeof body.version === "string" ? body.version.trim() : "";
  const buildNumber = typeof body.buildNumber === "string" ? body.buildNumber.trim() : "";
  const extension = app.platform === "macos" ? ".pkg" : ".ipa";
  const fileName = typeof body.fileName === "string" && body.fileName.toLowerCase().endsWith(extension) ? body.fileName : "";
  const fileSize = typeof body.fileSize === "number" && Number.isInteger(body.fileSize) && body.fileSize > 0 ? body.fileSize : 0;
  if (!version || !buildNumber || !fileName || !fileSize) throw new HttpError(400, `version, buildNumber, fileName (${extension}) and fileSize are required`);
  const apple = appleClient(env, deps, await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
  let reserved: Awaited<ReturnType<AppleClient["reserveBuildUpload"]>>;
  let recordId: number | undefined;
  const record = async (uploadId: string, fileId: string | null) => {
    const db = Db.from(env);
    if (recordId !== undefined) {
      if (fileId) await db.setUploadFile(recordId, fileId);
      return;
    }
    const now = deps.now().toISOString();
    recordId = await db.insertTestflightBuild({ appId: app.id, platform: app.platform ?? "ios", version, buildNumber, uploadId, uploadFileId: fileId, buildId: null, whatsNew: typeof body.whatsNew === "string" ? body.whatsNew.slice(0, 4000) : null, state: "uploading", message: null, createdAt: now, updatedAt: now });
  };
  try {
    reserved = await apple.reserveBuildUpload(app.ascAppId, version, buildNumber, fileName, fileSize, app.platform ?? "ios", check, record);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
  await check();
  return { uploadFileId: reserved.fileId, operations: reserved.operations };
}

export async function commitUpload(env: Env, deps: Deps, app: AppRow, body: { uploadFileId?: unknown; md5?: unknown }) {
  const check = () => requireTarget(env, app);
  await check();
  const fileId = typeof body.uploadFileId === "string" ? body.uploadFileId : "";
  const md5 = typeof body.md5 === "string" && /^[0-9a-f]{32}$/i.test(body.md5) ? body.md5.toLowerCase() : "";
  if (!fileId || !md5) throw new HttpError(400, "uploadFileId and md5 (32 hex characters) are required");
  const db = Db.from(env);
  const row = await db.testflightBuild(app.id, fileId, app.platform ?? "ios");
  if (!row) throw new HttpError(404, "no upload with that id for this app");
  const apple = appleClient(env, deps, await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
  try {
    await apple.commitBuildUpload(fileId, md5, check);
  } catch (err) {
    if (err instanceof TargetDisabledError) throw err;
    row.state = "failed";
    row.message = err instanceof Error ? err.message : String(err);
    row.updatedAt = deps.now().toISOString();
    await db.updateTestflightBuild(row);
    throw new HttpError(502, row.message);
  }
  row.state = "uploaded";
  row.updatedAt = deps.now().toISOString();
  await db.updateTestflightBuild(row);
  return { state: row.state };
}

// Moves one build on: processing, into the friends' group with its notes and off to beta review, then
// through the review until friends can install it. Apple's export compliance question gets "no
// non-exempt encryption" for every build (ITSAppUsesNonExemptEncryption NO); the terms make that the developer's to keep true.
export async function advanceBuild(apple: AppleClient, app: AppRow, row: TestflightBuildRow, now: string): Promise<void> {
  if (row.state === "uploaded" && row.uploadId) {
    const up = await apple.buildUploadState(row.uploadId);
    if (up.state === "FAILED") {
      row.state = "failed";
      row.message = up.errors.join("; ") || "Apple rejected the upload";
      return;
    }
  }
  const build = await apple.findBuild(app.ascAppId!, row.version, row.buildNumber, app.platform ?? "ios");
  if (!build) return;
  row.buildId = build.id;
  row.expiresAt = build.expirationDate;
  if (build.expired) {
    row.state = "expired";
    row.message = null;
    return;
  }
  if (build.processingState === "PROCESSING") {
    row.state = "processing";
    return;
  }
  if (build.processingState !== "VALID") {
    row.state = "failed";
    row.message = `Apple marked the build ${build.processingState.toLowerCase()}`;
    return;
  }
  if (build.usesNonExemptEncryption === null) await apple.setBuildEncryption(build.id, false);
  if (row.state === "uploaded" || row.state === "processing") {
    await apple.addBuildToGroup(app.betaGroupId!, build.id);
    if (row.whatsNew) await apple.setWhatsNew(build.id, row.whatsNew);
    const detail = await apple.betaDetail(build.id);
    if (!detail.autoNotifyEnabled) await apple.setAutoNotify(detail.id);
    await submit(apple, build.id, app);
    row.state = "in-review";
    row.submittedAt = now;
    row.message = null;
    return;
  }
  const detail = await apple.betaDetail(build.id);
  row.appleState = detail.externalBuildState;
  switch (detail.externalBuildState) {
    case "READY_FOR_BETA_TESTING":
    case "IN_BETA_TESTING":
      row.state = "open";
      row.message = null;
      break;
    case "BETA_APPROVED":
      row.state = "approved";
      row.message = null;
      if (!row.notifiedAt) {
        try {
          await apple.notifyTesters(build.id);
        } catch (err) {
          if (!(err instanceof AppleError && err.status === 409)) throw err;
        }
        row.notifiedAt = now;
      }
      break;
    case "BETA_REJECTED":
      row.state = "rejected";
      row.message = "Apple's beta review did not approve this build. Apple's reasons are in App Store Connect: Apps, the app, TestFlight.";
      break;
    case "EXPIRED":
      row.state = "expired";
      break;
    case "READY_FOR_BETA_SUBMISSION":
      // Not with Apple's review yet, for example after a refused submission; ask again.
      await submit(apple, build.id, app);
      row.state = "in-review";
      break;
    case "MISSING_EXPORT_COMPLIANCE":
      await apple.setBuildEncryption(build.id, false);
      row.state = "processing";
      break;
    default:
      row.state = "in-review";
  }
}

async function submit(apple: AppleClient, buildId: string, app: AppRow, retried = false): Promise<void> {
  try {
    await apple.submitForBetaReview(buildId);
  } catch (err) {
    // A build of a version Apple already reviewed may need no review, or may already be submitted.
    if (err instanceof AppleError && err.status === 409) return;
    // Apple refuses review without a beta description in the app's primary language: write it, try once more.
    if (!retried && err instanceof AppleError && /betaAppLocalization/i.test(err.message)) {
      const found = await apple.setBetaDescription(app.ascAppId!, { description: app.description || app.tagline || app.name });
      try {
        return await submit(apple, buildId, app, true);
      } catch (again) {
        throw new Error(`${again instanceof Error ? again.message : String(again)} (${found})`);
      }
    }
    throw err;
  }
}

// What testflight.apple.com shows a friend for the public link. null when the page could not be read.
export async function checkInvitation(deps: Deps, url: string): Promise<LinkState | null> {
  let res: Response;
  try {
    res = await deps.fetch(url, { headers: { "Accept-Language": "en-US,en;q=0.8", "User-Agent": "ourapps (+https://ourapps.app)" } });
  } catch {
    return null;
  }
  if (res.status === 404) return "missing";
  if (!res.ok) return null;
  const page = await res.text();
  if (/isn(?:'|&#39;|&#x27;|’)t accepting any new testers/i.test(page)) return "not-accepting";
  if (/This beta is full/i.test(page)) return "full";
  if (/<title>\s*Join the /i.test(page)) return "open";
  return null;
}

// Public reads check pending approvals at most once a minute; Apple receives no changes here.
export async function refreshApprovedVersions(env: Env, deps: Deps, app: AppRow): Promise<void> {
  if (!app.ascAppId || !app.betaGroupId) return;
  if (app.testflightCheckedAt && deps.now().getTime() - Date.parse(app.testflightCheckedAt) < 60_000) return;
  const db = Db.from(env);
  const pending = await db.pendingTestflightBuilds(app.id, app.platform ?? "ios");
  if (pending.length === 0) return;
  try {
    const apple = appleClient(env, deps, await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
    for (const row of pending) {
      if (!row.buildId) continue;
      const detail = await apple.betaDetail(row.buildId);
      if (!["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(detail.externalBuildState)) continue;
      row.state = "open";
      row.appleState = detail.externalBuildState;
      row.message = null;
      row.updatedAt = deps.now().toISOString();
      await db.updateTestflightBuild(row);
    }
    await checkLink(env, deps, apple, app);
  } catch (err) {
    console.error(`testflight approval ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface PlatformBuildReservation {
  version: string;
  buildNumber: string;
}

export async function reservePlatformBuild(env: Env, deps: Deps, app: AppRow, metadata?: BuildRunMetadata): Promise<PlatformBuildReservation> {
  const check = () => requireTarget(env, app);
  await check();
  if (app.platform !== "macos" && app.platform !== "tvos") throw new HttpError(400, "Build-number reservation supports macos and tvos only; ios reservation is unsupported.");
  if (!app.ascAppId) throw new HttpError(409, "Set up TestFlight for this platform before reserving a build number.");
  let secrets: DeveloperSecrets;
  try { secrets = await loadSecrets(env, app.developerId, ["githubToken", "appleIssuerId", "appleKeyId", "applePrivateKey"]); }
  catch { throw new HttpError(502, "Could not read the saved credentials for build reservation. Check account settings."); }
  if (!secrets.githubToken) throw new HttpError(502, `Save a GitHub token with repository access and Contents: read${metadata ? " and Actions: read" : ""} in account settings to reserve Mac or Apple TV builds.`);
  const db = Db.from(env);
  let verified: VerifiedBuildRun | undefined;
  if (metadata) {
    verified = await verifyBuildRun(env, deps, app, secrets.githubToken, metadata);
    try {
      const existing = await db.buildRunReservation(app.id, app.platform, app.repo, metadata);
      await check();
      if (existing) return { version: existing.version, buildNumber: existing.buildNumber };
    } catch (err) { if (err instanceof TargetDisabledError) throw err; throw new HttpError(502, "Could not read the verified build reservation. Retry with the same runId and runAttempt."); }
  }
  let version: string;
  const manifestDeps: Deps = { ...deps, fetch: (input, init) => fetchBuildManifest(deps.fetch, input instanceof Request ? input.url : String(input), init?.headers) };
  try { version = (await loadManifest(env, manifestDeps, app, secrets.githubToken)).version; }
  catch (err) {
    throw new HttpError(502, err instanceof GithubBuildRequestError ? err.message : "Could not load a valid latest my-app.json. Publish a release with a valid manifest and version, and grant the GitHub token Contents: read in account settings.");
  }
  let appleMaximum: number;
  try { appleMaximum = await appleClient(env, deps, secrets).maximumBuildNumber(app.ascAppId, version, app.platform); }
  catch (err) {
    throw new HttpError(502, err instanceof BuildNumberError ? err.message : "Could not verify all existing Apple build numbers for this app, platform and version. Check the saved App Store Connect key has access to this app and permission to read builds, then retry. No workflow was requested; incomplete or excessive pagination also blocks allocation.");
  }
  try {
    await check();
    const buildNumber = await db.reserveBuildNumber(app.id, app.platform, version, appleMaximum, check);
    if (verified) {
      const saved = await db.associateBuildRun(app.id, app.platform, version, String(buildNumber), verified, deps.now().toISOString());
      await check();
      return { version: saved.version, buildNumber: saved.buildNumber };
    }
    await check();
    return { version, buildNumber: String(buildNumber) };
  } catch (err) {
    if (err instanceof TargetDisabledError) throw err;
    throw new HttpError(502, err instanceof BuildNumberError ? err.message : "Could not atomically reserve an Apple build number. Retry after checking the build reservation database is available.");
  }
}

// Requests the platform's workflow using one reserved input and keeps the dispatch outcome on the app.
export async function requestBuild(env: Env, deps: Deps, app: AppRow, reason: string): Promise<void> {
  const check = () => requireTarget(env, app);
  await check();
  const at = deps.now().toISOString();
  let error: string | null = null;
  try {
    const secrets = await loadSecrets(env, app.developerId, ["githubToken"]);
    if (app.platform === "macos" || app.platform === "tvos") {
      if (!secrets.githubToken) throw new GithubBuildRequestError("Save a GitHub token with repository access, Contents: read and Actions: write in account settings to request Mac or Apple TV builds.");
      const reservation = await reservePlatformBuild(env, deps, app);
      await dispatchAppleWorkflow(env, deps, secrets.githubToken, app.repo, app.platform, reservation.version, Number(reservation.buildNumber), check);
    } else {
      await dispatchEvent(env, deps, secrets.githubToken, app.repo, RELEASE_EVENT, { app: app.id, reason }, check);
    }
  } catch (err) {
    if (err instanceof TargetDisabledError) throw err;
    error = app.platform === "macos" || app.platform === "tvos"
      ? err instanceof GithubBuildRequestError || err instanceof HttpError ? err.message : "Could not request the Apple platform build. Check the repository, latest manifest, and GitHub token with Contents: read and Actions: write in account settings."
      : err instanceof Error ? err.message : String(err);
  }
  app.buildRequestedAt = at;
  app.buildRequestError = error;
  if (app.platform && app.platform !== "ios") await Db.from(env).setAppTestflight(app);
  else await Db.from(env).setBuildRequest(app.id, at, error);
}

// One app, now: moves its builds on and reads its invitation page. Used by the console and the schedule.
export async function refreshTestflight(env: Env, deps: Deps, app: AppRow, apple?: AppleClient): Promise<void> {
  if (!app.ascAppId || !app.betaGroupId) return;
  const db = Db.from(env);
  const client = apple ?? appleClient(env, deps, await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
  for (const row of (await db.pendingTestflightBuilds(app.id, app.platform ?? "ios")).slice(0, 3)) await advanceOne(db, deps, client, app, row);
  await checkLink(env, deps, client, app);
}

async function advanceOne(db: Db, deps: Deps, apple: AppleClient, app: AppRow, row: TestflightBuildRow): Promise<void> {
  try {
    await advanceBuild(apple, app, row, deps.now().toISOString());
  } catch (err) {
    row.message = err instanceof Error ? err.message : String(err);
  }
  row.updatedAt = deps.now().toISOString();
  await db.updateTestflightBuild(row);
}

async function checkLink(env: Env, deps: Deps, apple: AppleClient, app: AppRow): Promise<void> {
  const db = Db.from(env);
  if (!app.testflightUrl && app.betaGroupId) {
    const link = await apple.betaGroupLink(app.betaGroupId);
    if (link) {
      app.testflightUrl = link;
      await db.setAppTestflight(app);
    }
  }
  const state = app.testflightUrl ? await checkInvitation(deps, app.testflightUrl) : null;
  const at = deps.now().toISOString();
  if (state !== null) app.testflightLinkState = state;
  app.testflightCheckedAt = at;
  if (app.platform && app.platform !== "ios") await db.setAppTestflight(app);
  else await db.setLinkState(app.id, app.testflightLinkState ?? null, at);
}

// Run on a schedule: move pending builds on, read each invitation page, and ask for a fresh build
// before the newest one expires. Each run stays well inside the free plan's 50 outbound calls.
export async function tickTestflight(env: Env, deps: Deps): Promise<void> {
  const db = Db.from(env);
  const apps = new Map<string, AppRow>();
  const clients = new Map<string, AppleClient>();
  const clientFor = async (devId: string) => {
    if (!clients.has(devId)) clients.set(devId, appleClient(env, deps, await loadSecrets(env, devId, ["appleIssuerId", "appleKeyId", "applePrivateKey"])));
    return clients.get(devId)!;
  };
  for (const row of (await db.pendingTestflightBuilds()).slice(0, 4)) {
    const key = `${row.appId}:${row.platform ?? "ios"}`;
    const base = await db.appById(row.appId);
    const app = apps.get(key) ?? (base ? await db.platformApp(base, row.platform ?? "ios") : null);
    if (!app?.ascAppId || !app.betaGroupId) continue;
    apps.set(key, app);
    try {
      await advanceOne(db, deps, await clientFor(app.developerId), app, row);
    } catch (err) {
      console.error(`testflight build ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const app of (await db.appsWithTestflight()).slice(0, 4)) {
    try {
      const apple = await clientFor(app.developerId);
      await checkLink(env, deps, apple, app);
      await refreshIfExpiring(env, deps, db, apple, app);
    } catch (err) {
      if (err instanceof TargetDisabledError) continue;
      console.error(`testflight ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// The first build is asked for when TestFlight is set up, or from the app's page; this keeps it alive.
async function refreshIfExpiring(env: Env, deps: Deps, db: Db, apple: AppleClient, app: AppRow): Promise<void> {
  await requireTarget(env, app);
  const now = deps.now().getTime();
  const week = 7 * 86_400_000;
  if (app.buildRequestedAt && now - Date.parse(app.buildRequestedAt) < week) return;
  const recent = (await db.testflightBuilds(app.id, 1, app.platform ?? "ios"))[0];
  if (!recent || now - Date.parse(recent.createdAt) < week) return;
  const live = await apple.latestLiveBuild(app.ascAppId!, app.platform ?? "ios");
  const expires = live?.expirationDate ? Date.parse(live.expirationDate) : null;
  if (live && expires !== null && expires - now > REFRESH_DAYS * 86_400_000) return;
  await requestBuild(env, deps, app, "testflight-expiry");
}

export const RELEASE_EVENT = "my-store-release";

// Where an app set up for TestFlight stands, from the developer's side; the console's card and agents read it.
export type TestflightStage = "no-build" | "waiting-for-upload" | "processing" | "in-review" | "approved" | "open" | "link-closed" | "rejected" | "failed";

export function testflightStage(app: AppRow, builds: TestflightBuildRow[]): TestflightStage {
  if (app.testflightLinkState === "open" && builds.some((b) => b.state === "open")) return "open";
  const latest = builds[0];
  const requestedAfter = app.buildRequestedAt && (!latest || app.buildRequestedAt > latest.createdAt);
  if (requestedAfter && !app.buildRequestError) return "waiting-for-upload";
  if (!latest) return "no-build";
  if (builds.some((b) => b.state === "open")) return app.testflightLinkState ? "link-closed" : "approved";
  switch (latest.state) {
    case "uploading":
    case "uploaded":
    case "processing":
      return "processing";
    case "in-review":
    case "approved":
    case "rejected":
    case "failed":
      return latest.state;
    default:
      return "no-build";
  }
}
