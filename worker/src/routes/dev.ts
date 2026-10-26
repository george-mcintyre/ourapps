// Developer dashboard routes: a browser session or an API key; requireSession marks the browser-only ones.
import { SCREENSHOT_PLATFORMS, TERMS_VERSION, defaultAppTargets, isAppTarget, type ScreenshotPlatform } from "@my/store-shared";
import { audit } from "../audit.js";
import { RESERVED_SLUGS, apiKeyHash, clearSessionCookie, masterKeys, newApiKey, normaliseSlug, requireSession, type AuthedDeveloper } from "../auth.js";
import { randomId, tokenHash, validateAppleKey, validateSigningKey } from "../crypto.js";
import { Db, type ApiKeyRow, type AppRow, type Developer, type DeveloperSecrets, type KeyScope, type LinkRow, type SigningCertificateRow } from "../db.js";
import { defaultDeps, type Deps, type Env } from "../env.js";
import { loadBuildStatus } from "../github.js";
import { appleClient, dlUrl } from "../flow.js";
import { HttpError, httpsUrlOrEmpty, json, readJson, text } from "../http.js";
import { EDITABLE_SECRET_FIELDS, appleReady, loadSecrets, saveSecrets, secretsSummary } from "../secrets.js";
import { CHANGELOG_ASSET } from "../history.js";
import { fetchManifest, loadManifest, resolveRelease } from "../upstream.js";
import { webHosting } from "../webapp.js";
import { localNeed, refreshTestflight, renewStoreProfile, requestBuild, reviewContact, setUpTestflight, storeAppForm, testflightStage, type TestflightNeed } from "../testflight.js";
import { applePlatform, profileType } from "../apple-platform.js";
import { buildLinkPage } from "./public.js";
import { requireTarget, TargetDisabledError } from "../targets.js";

type AppInput = Partial<Record<"name" | "tagline" | "description" | "whatsNew" | "size" | "minOs" | "ageNote" | "privacySummary" | "iconUrl" | "repo" | "manifestUrl" | "bundleId", string>> & {
  screenshots?: unknown;
  screenshotsByPlatform?: unknown;
  showOnPage?: unknown;
};

function buildTokenHash(env: Env, token: string): Promise<string> {
  return tokenHash(masterKeys(env), "build-token", token);
}

// The App object agents.md documents; TestFlight detail is in the TestFlight view.
function publicApp(app: AppRow) {
  const {
    buildTokenHash: _hash,
    storeProfileBase64: _profile,
    storeProfileId: _pid,
    storeProfileUuid: _puuid,
    storeProfileName: _pname,
    betaGroupId: _group,
    testflightLinkState: _link,
    testflightCheckedAt: _checked,
    buildRequestedAt: _requested,
    buildRequestError: _requestError,
    iosOnMac: _iosOnMac,
    iosOnMacCheckedAt: _iosOnMacCheckedAt,
    ...rest
  } = app;
  return { ...rest, targets: app.targets ?? defaultAppTargets() };
}

function applyInput(app: AppRow, body: AppInput): void {
  if (body.name !== undefined) app.name = text(body.name, 80);
  if (app.name === "") throw new HttpError(400, "name is required");
  if (body.repo !== undefined) app.repo = text(body.repo, 120);
  if (!/^[\w.-]+\/[\w.-]+$/.test(app.repo)) throw new HttpError(400, "repo must be owner/name");
  if (body.tagline !== undefined) app.tagline = text(body.tagline, 120);
  if (body.description !== undefined) app.description = text(body.description, 4000);
  if (body.whatsNew !== undefined) app.whatsNew = text(body.whatsNew, 2000);
  if (body.size !== undefined) app.size = text(body.size, 40);
  if (body.minOs !== undefined) app.minOs = text(body.minOs, 80);
  if (body.ageNote !== undefined) app.ageNote = text(body.ageNote, 120);
  if (body.privacySummary !== undefined) app.privacySummary = text(body.privacySummary, 2000);
  if (body.iconUrl !== undefined) app.iconUrl = httpsUrlOrEmpty(body.iconUrl);
  if (body.manifestUrl !== undefined) app.manifestUrl = httpsUrlOrEmpty(body.manifestUrl);
  if (body.bundleId !== undefined) {
    app.bundleId = text(body.bundleId, 155);
    if (app.bundleId !== "" && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.bundleId)) throw new HttpError(400, "bundleId must look like com.yourname.app");
  }
  if (body.showOnPage !== undefined) app.showOnPage = body.showOnPage === true;
  if (body.screenshots !== undefined) {
    if (!Array.isArray(body.screenshots) || body.screenshots.length > 10) throw new HttpError(400, "screenshots must be a list of at most 10 https URLs");
    app.screenshots = body.screenshots.map((s) => httpsUrlOrEmpty(s)).filter((s) => s !== "");
  }
  if (body.screenshotsByPlatform !== undefined) {
    const sp = body.screenshotsByPlatform;
    if (typeof sp !== "object" || sp === null || Array.isArray(sp)) throw new HttpError(400, "screenshotsByPlatform must be an object with keys iphone, ipad, android and web");
    const next: Partial<Record<ScreenshotPlatform, string[]>> = {};
    for (const [key, list] of Object.entries(sp)) {
      if (!(SCREENSHOT_PLATFORMS as readonly string[]).includes(key)) throw new HttpError(400, "screenshotsByPlatform keys must be iphone, ipad, android or web");
      if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, `screenshotsByPlatform.${key} must be a list of at most 10 https URLs`);
      const urls = list.map((u) => httpsUrlOrEmpty(u)).filter((u) => u !== "");
      if (urls.length > 0) next[key as ScreenshotPlatform] = urls;
    }
    app.screenshotsByPlatform = next;
  }
}

async function ownedApp(db: Db, dev: Developer, id: string): Promise<AppRow> {
  const app = await db.appById(id);
  if (!app || app.developerId !== dev.id) throw new HttpError(404, "unknown app");
  return app;
}

// The certificate counts only while its private key is stored too.
function signingStatus(s: DeveloperSecrets, c: SigningCertificateRow | null) {
  return c && s.signingKey ? { name: c.name, serialNumber: c.serialNumber, expirationDate: c.expirationDate, createdAt: c.createdAt } : null;
}

// What the dashboard may know about stored credentials: presence and save dates, never values.
function secretStatus(s: DeveloperSecrets, signing: SigningCertificateRow | null) {
  const at = s.savedAt ?? {};
  const appleDates = [at.appleIssuerId, at.appleKeyId, at.applePrivateKey].filter((d): d is string => Boolean(d)).sort();
  return {
    apple: appleReady(s),
    appleSavedAt: appleReady(s) ? appleDates[appleDates.length - 1] ?? null : null,
    appleTeamId: s.appleTeamId ?? "",
    appleTeamIdSavedAt: s.appleTeamId ? at.appleTeamId ?? null : null,
    github: Boolean(s.githubToken),
    githubSavedAt: s.githubToken ? at.githubToken ?? null : null,
    signing: signingStatus(s, signing),
  };
}

// GET /api/dev/me
export async function me(env: Env, dev: AuthedDeveloper): Promise<Response> {
  const { authVia, scope, keyId: _k, ...developer } = dev;
  // The summary only marks fields as present; the team ID is shown, so it alone is decrypted.
  const [summary, team, signing] = await Promise.all([secretsSummary(env, dev.id), loadSecrets(env, dev.id, ["appleTeamId"]), Db.from(env).signingCertificate(dev.id)]);
  return json({ developer, authVia, scope, termsVersion: TERMS_VERSION, secrets: secretStatus({ ...summary, appleTeamId: team.appleTeamId }, signing), reviewContact: reviewContact(dev) });
}

// POST /api/dev/terms - dashboard only; records acceptance of the current terms.
export async function acceptTerms(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const body = await readJson<{ version?: string }>(request);
  if (body.version !== TERMS_VERSION) throw new HttpError(400, `the current terms are version ${TERMS_VERSION}`);
  const now = deps.now().toISOString();
  await Db.from(env).acceptTerms(dev.id, TERMS_VERSION, now);
  await audit(request, env, deps, dev.id, "terms-accepted", TERMS_VERSION);
  return json({ ok: true, termsAcceptedVersion: TERMS_VERSION, termsAcceptedAt: now });
}

// DELETE /api/dev/me - dashboard only; the body must name the GitHub login to confirm.
export async function deleteAccount(request: Request, env: Env, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const body = await readJson<{ confirm?: string }>(request);
  if (body.confirm !== dev.githubLogin) throw new HttpError(400, "type your GitHub login to confirm");
  await Db.from(env).deleteDeveloper(dev.id);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie(env) },
  });
}

// PUT /api/dev/me
export async function updateMe(request: Request, env: Env, dev: Developer): Promise<Response> {
  const body = await readJson<{ slug?: string; displayName?: string }>(request);
  const slug = normaliseSlug(text(body.slug, 40));
  const displayName = text(body.displayName, 80);
  if (slug === "" || RESERVED_SLUGS.has(slug)) throw new HttpError(400, "that page name is not available");
  if (displayName === "") throw new HttpError(400, "display name is required");
  const db = Db.from(env);
  const taken = await db.developerBySlug(slug);
  if (taken && taken.id !== dev.id) throw new HttpError(409, "that page name is taken");
  await db.updateDeveloper(dev.id, slug, displayName);
  return json({ developer: { ...dev, slug, displayName } });
}

// PUT /api/dev/secrets - dashboard only. Blank fields keep their current value; "-" clears one.
export async function updateSecrets(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const body = await readJson<Partial<DeveloperSecrets>>(request);
  const current = await loadSecrets(env, dev.id);
  const next: DeveloperSecrets = { ...current, savedAt: { ...current.savedAt } };
  const now = deps.now().toISOString();
  const saved: string[] = [];
  const removed: string[] = [];
  for (const key of EDITABLE_SECRET_FIELDS) {
    const value = body[key];
    // Blank keeps the saved value; so does the same value again (the form pre-fills the team ID).
    if (typeof value !== "string" || value.trim() === "" || value.trim() === current[key]) continue;
    if (value.trim() === "-") {
      delete next[key];
      delete next.savedAt![key];
      removed.push(key);
    } else {
      next[key] = value.trim();
      next.savedAt![key] = now;
      saved.push(key);
    }
  }
  if (saved.includes("applePrivateKey") && !(await validateAppleKey(next.applePrivateKey!))) {
    throw new HttpError(400, "the Apple private key must be the contents of the .p8 file from App Store Connect (an EC P-256 key)");
  }
  if (saved.includes("appleTeamId") && !/^[A-Z0-9]{10}$/.test(next.appleTeamId!)) {
    throw new HttpError(400, "the Apple team ID is ten capital letters and digits, from Membership details on developer.apple.com");
  }
  if (saved.includes("githubToken") && !/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(next.githubToken!)) {
    throw new HttpError(400, "that does not look like a GitHub token (expected github_pat_... or ghp_...)");
  }
  await saveSecrets(env, dev.id, next, deps.now());
  if (saved.length > 0) await audit(request, env, deps, dev.id, "credentials-saved", saved.join(", "));
  if (removed.length > 0) await audit(request, env, deps, dev.id, "credentials-removed", removed.join(", "));
  return json({ secrets: secretStatus(next, await Db.from(env).signingCertificate(dev.id)) });
}

// POST /api/dev/signing - dashboard only. The browser makes the RSA key and the certificate signing
// request; Apple issues an Apple Distribution certificate and the key is stored encrypted. Apps
// already on TestFlight get their App Store profile made again with it.
export async function setUpSigning(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const body = await readJson<{ csr?: unknown; privateKey?: unknown }>(request);
  const csr = typeof body.csr === "string" ? body.csr.trim() : "";
  const privateKey = typeof body.privateKey === "string" ? body.privateKey.trim() : "";
  if (!/^-----BEGIN CERTIFICATE REQUEST-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE REQUEST-----$/.test(csr) || csr.length > 4000) {
    throw new HttpError(400, "csr must be a PEM certificate signing request");
  }
  if (!(await validateSigningKey(privateKey))) throw new HttpError(400, "privateKey must be a 2048-bit RSA private key in PKCS #8 PEM form");
  const db = Db.from(env);
  const secrets = await loadSecrets(env, dev.id);
  const apple = appleClient(env, deps, secrets);
  let issued: Awaited<ReturnType<typeof apple.createDistributionCertificate>>;
  try {
    issued = await apple.createDistributionCertificate(csr);
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
  const now = deps.now().toISOString();
  const certificate: SigningCertificateRow = {
    developerId: dev.id,
    certificateId: issued.id,
    name: issued.name,
    serialNumber: issued.serialNumber,
    certificateBase64: issued.certificateContent,
    expirationDate: issued.expirationDate,
    createdAt: now,
  };
  await saveSecrets(env, dev.id, { ...secrets, signingKey: privateKey, savedAt: { ...secrets.savedAt, signingKey: now } }, deps.now());
  await db.putSigningCertificate(certificate);
  await audit(request, env, deps, dev.id, "signing-set-up", `${issued.name} ${issued.serialNumber}`);
  const apps = [];
  for (const app of (await db.appsWithTestflight()).filter((app) => app.developerId === dev.id)) {
    if (!app.ascAppId) continue;
    try {
      await renewStoreProfile(env, apple, app, issued.id);
      apps.push({ id: app.id, name: app.name, error: null });
    } catch (err) {
      if (err instanceof TargetDisabledError) continue;
      apps.push({ id: app.id, name: app.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return json({ signing: signingStatus({ signingKey: privateKey }, certificate), apps }, 201);
}

// GET /api/dev/apps - apps without a dashboard icon get the latest release icon, best effort.
export async function listApps(env: Env, deps: Deps, dev: Developer): Promise<Response> {
  const apps = await Db.from(env).appsByDeveloper(dev.id);
  const secrets = await loadSecrets(env, dev.id, ["githubToken"]);
  const out = await Promise.all(
    apps.map(async (app) => {
      let releaseIcon = "";
      if (!app.iconUrl) {
        try {
          const icon = (await loadManifest(env, deps, app, secrets.githubToken)).icon;
          releaseIcon = new URL(icon).host === "api.github.com" ? await dlUrl(env, deps, { url: icon, kind: "icon", dev: dev.id }) : icon;
        } catch {
          releaseIcon = "";
        }
      }
      return { ...publicApp(app), releaseIcon };
    }),
  );
  return json({ apps: out });
}

// POST /api/dev/apps - returns the build token once.
export async function createApp(request: Request, env: Env, deps: Deps, dev: Developer): Promise<Response> {
  const body = await readJson<AppInput>(request);
  const now = deps.now().toISOString();
  const buildToken = randomId(24);
  const app: AppRow = {
    id: randomId(8),
    developerId: dev.id,
    name: "",
    tagline: "",
    description: "",
    whatsNew: "",
    size: "",
    minOs: "",
    ageNote: "",
    privacySummary: "",
    iconUrl: "",
    screenshots: [],
    screenshotsByPlatform: {},
    repo: "",
    manifestUrl: "",
    bundleId: "",
    showOnPage: false,
    buildTokenHash: await buildTokenHash(env, buildToken),
    createdAt: now,
    updatedAt: now,
  };
  applyInput(app, body);
  await Db.from(env).insertApp(app);
  await audit(request, env, deps, dev.id, "app-created", app.name);
  return json({ app: publicApp(app), buildToken }, 201);
}

// GET /api/dev/apps/:id
export async function getApp(env: Env, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  return json({ app: publicApp(app), links: await db.linksByApp(app.id) });
}

export async function setTarget(request: Request, env: Env, dev: Developer, id: string, target: string): Promise<Response> {
  const db = Db.from(env);
  await ownedApp(db, dev, id);
  if (!isAppTarget(target)) throw new HttpError(400, "Unknown target.");
  const body = await readJson<unknown>(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("enabled" in body) || typeof body.enabled !== "boolean") throw new HttpError(400, "Body must contain exactly enabled as a boolean.");
  return json({ targets: await db.setAppTarget(id, target, body.enabled) });
}

// PUT /api/dev/apps/:id
export async function updateApp(request: Request, env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  applyInput(app, await readJson<AppInput>(request));
  app.updatedAt = deps.now().toISOString();
  await db.updateApp(app);
  return json({ app: publicApp(app) });
}

// DELETE /api/dev/apps/:id
export async function deleteApp(request: Request, env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  await db.deleteApp(id);
  await audit(request, env, deps, dev.id, "app-deleted", app.name);
  return json({ ok: true });
}

// POST /api/dev/apps/:id/build-token - rotate the per-app token.
export async function rotateBuildToken(request: Request, env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  const buildToken = randomId(24);
  app.buildTokenHash = await buildTokenHash(env, buildToken);
  app.updatedAt = deps.now().toISOString();
  await db.updateApp(app);
  await audit(request, env, deps, dev.id, "build-token-rotated", app.name);
  return json({ buildToken });
}

// POST /api/dev/apps/:id/links
export async function createLink(request: Request, env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  const body = await readJson<{ label?: string; expiresAt?: string | null }>(request);
  let expiresAt: string | null = null;
  if (body.expiresAt) {
    const t = Date.parse(body.expiresAt);
    if (Number.isNaN(t)) throw new HttpError(400, "expiresAt must be a date");
    expiresAt = new Date(t).toISOString();
  }
  const link: LinkRow = { id: randomId(12), appId: app.id, developerId: dev.id, label: text(body.label, 80), createdAt: deps.now().toISOString(), expiresAt, revokedAt: null };
  await db.insertLink(link);
  return json({ link, url: `${env.PUBLIC_ORIGIN}/l/${link.id}` }, 201);
}

// POST /api/dev/links/:id/revoke and DELETE /api/dev/links/:id
// PUT /api/dev/links/:id - change the label only; the link's address stays the same.
export async function renameLink(request: Request, env: Env, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const link = await db.linkById(id);
  if (!link || link.developerId !== dev.id) throw new HttpError(404, "unknown link");
  const body = await readJson<{ label?: unknown }>(request);
  if (typeof body.label !== "string") throw new HttpError(400, "label must be a string");
  const label = text(body.label, 80);
  await db.renameLink(id, label);
  return json({ link: { ...link, label } });
}

export async function revokeLink(env: Env, deps: Deps, dev: Developer, id: string, remove: boolean): Promise<Response> {
  const db = Db.from(env);
  const link = await db.linkById(id);
  if (!link || link.developerId !== dev.id) throw new HttpError(404, "unknown link");
  if (remove) await db.deleteLink(id);
  else await db.revokeLink(id, deps.now().toISOString());
  return json({ ok: true });
}

// GET /api/dev/apps/:id/testflight - where TestFlight stands for the app and its latest uploads.
// Before set-up, "needs" names the developer's next step; null with setUp false means ourapps can go
// ahead (POST) and find out whether the app is in App Store Connect yet. After set-up, "stage" says
// what the invitation waits for.
export async function testflightStatus(env: Env, dev: Developer, id: string, platformName = "ios", deps: Deps = defaultDeps): Promise<Response> {
  const db = Db.from(env);
  const app = await db.platformApp(await ownedApp(db, dev, id), applePlatform(platformName));
  return json(await testflightView(env, deps, db, app, dev, app.ascAppId ? null : await localNeed(env, dev, app)));
}

async function testflightView(env: Env, deps: Deps, db: Db, app: AppRow, dev: Developer, needs: TestflightNeed | null) {
  const builds = await db.testflightBuilds(app.id, 6, app.platform ?? "ios");
  const secrets = await loadSecrets(env, dev.id, ["githubToken"]);
  const buildStatus = await loadBuildStatus(env, deps, app, secrets.githubToken, builds, secrets.savedAt?.githubToken);
  return {
    buildStatus,
    platform: app.platform ?? "ios",
    profileType: profileType(app.platform ?? "ios", app.nativeMac),
    setUp: Boolean(app.ascAppId),
    needs,
    // What to type into App Store Connect's New App form, until the app is set up.
    storeApp: app.ascAppId || !app.bundleId ? null : storeAppForm(app, dev),
    stage: app.ascAppId ? testflightStage(app, builds) : null,
    url: app.testflightUrl ?? null,
    // What testflight.apple.com shows a friend opening the invitation, and when ourapps last looked.
    invitation: { state: app.testflightLinkState ?? null, checkedAt: app.testflightCheckedAt ?? null },
    buildRequest: app.buildRequestedAt ? { at: app.buildRequestedAt, error: app.buildRequestError ?? null } : null,
    profile: app.storeProfileName ?? null,
    contact: Boolean(reviewContact(dev)),
    builds: builds.map((b) => ({
      version: b.version,
      buildNumber: b.buildNumber,
      state: b.state,
      appleState: b.appleState ?? null,
      message: b.message,
      uploadedAt: b.createdAt,
      submittedAt: b.submittedAt ?? null,
      expiresAt: b.expiresAt ?? null,
      updatedAt: b.updatedAt,
    })),
  };
}

// POST /api/dev/apps/:id/testflight - sets TestFlight up, then asks the repository for the first build.
// Once set up it checks with Apple now; body {"repair": true} runs the set-up again. Always 200.
export async function setUpAppTestflight(request: Request, env: Env, deps: Deps, dev: Developer, id: string, platformName = "ios"): Promise<Response> {
  const db = Db.from(env);
  const platform = applePlatform(platformName);
  if (platform === "macos") requireSession(dev as AuthedDeveloper);
  const app = await db.platformApp(await ownedApp(db, dev, id), platform);
  await requireTarget(env, app);
  const body = await optionalJson<{ repair?: unknown; nativeMac?: unknown }>(request);
  if (body.nativeMac !== undefined && (platform !== "macos" || typeof body.nativeMac !== "boolean")) throw new HttpError(400, "nativeMac must be a boolean for macos setup");
  if (body.nativeMac !== undefined && app.ascAppId && body.nativeMac !== app.nativeMac && body.repair !== true) throw new HttpError(409, "changing Mac profile type requires repair: true");
  if (typeof body.nativeMac === "boolean") app.nativeMac = body.nativeMac;
  let needs: TestflightNeed | null = null;
  if (!app.ascAppId || body.repair === true) {
    const wasSetUp = Boolean(app.ascAppId);
    needs = await setUpTestflight(env, deps, dev, app);
    if (!needs && !wasSetUp && (await db.testflightBuilds(app.id, 1, platform)).length === 0) await requestBuild(env, deps, app, "testflight-set-up");
  }
  if (!needs && app.ascAppId) {
    try {
      await refreshTestflight(env, deps, app);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  }
  return json(await testflightView(env, deps, db, app, dev, needs));
}

// POST /api/dev/apps/:id/testflight/build - asks the app's repository for a release now.
export async function requestAppBuild(env: Env, deps: Deps, dev: Developer, id: string, platformName = "ios"): Promise<Response> {
  const db = Db.from(env);
  const app = await db.platformApp(await ownedApp(db, dev, id), applePlatform(platformName));
  await requireTarget(env, app);
  if (!app.ascAppId) throw new HttpError(409, "set up TestFlight for this app first");
  await requestBuild(env, deps, app, "requested");
  return json(await testflightView(env, deps, db, app, dev, null));
}

async function optionalJson<T extends object>(request: Request): Promise<Partial<T>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

// PUT /api/dev/review-contact - who Apple's TestFlight beta review contacts.
export async function updateReviewContact(request: Request, env: Env, dev: Developer): Promise<Response> {
  const body = await readJson<{ firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown }>(request);
  const c = { firstName: text(body.firstName, 60), lastName: text(body.lastName, 60), email: text(body.email, 120), phone: text(body.phone, 40) };
  if (!c.firstName || !c.lastName) throw new HttpError(400, "first and last name are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new HttpError(400, "email must be an email address");
  if (!/^\+?[0-9 ().-]{6,}$/.test(c.phone)) throw new HttpError(400, "phone must be a phone number, for example +44 7700 900123");
  await Db.from(env).setReviewContact(dev.id, c);
  return json({ reviewContact: c });
}

// GET /api/dev/apps/:id/release - what the latest release looks like from the store's side.
export async function releaseStatus(env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const db = Db.from(env);
  const app = await ownedApp(db, dev, id);
  const secrets = await loadSecrets(env, dev.id);
  const base = { githubToken: Boolean(secrets.githubToken), appleKey: appleReady(secrets) };
  try {
    const release = await resolveRelease(env, deps, app, secrets.githubToken);
    const manifest = await fetchManifest(env, deps, app, release.manifestUrl, secrets.githubToken);
    return json({
      ok: true,
      ...base,
      tag: release.tag,
      publishedAt: release.publishedAt,
      assets: release.assets,
      manifestUrl: release.manifestUrl,
      version: manifest.version,
        install: { ios: Boolean(manifest.install.ios), android: Boolean(manifest.install.android), pwa: Boolean(manifest.install.pwa), macos: Boolean(manifest.install.macos), windows: Boolean(manifest.install.windows), tvos: Boolean(manifest.install.tvos) },
      web: await webHosting(deps, manifest.install.pwa, release),
      screenshots: (manifest.screenshots ?? []).length,
      changelog: release.assets.some((n) => CHANGELOG_ASSET.test(n)),
      errors: [],
    });
  } catch (err) {
    return json({ ok: false, ...base, tag: null, publishedAt: null, assets: [], manifestUrl: null, version: null, install: null, web: null, screenshots: 0, changelog: false, errors: [err instanceof Error ? err.message : String(err)] });
  }
}

// GET /api/dev/apps/:id/preview - the install page data without a share link.
export async function previewApp(env: Env, deps: Deps, dev: Developer, id: string): Promise<Response> {
  const app = await ownedApp(Db.from(env), dev, id);
  return json({ ...(await buildLinkPage(env, deps, app, dev, null)), preview: true });
}

function publicKey(k: ApiKeyRow) {
  const { keyHash: _hash, ...rest } = k;
  return rest;
}

// GET /api/dev/keys
export async function listKeys(env: Env, dev: Developer): Promise<Response> {
  return json({ keys: (await Db.from(env).apiKeysByDeveloper(dev.id)).map(publicKey) });
}

const MAX_KEY_DAYS = 365;

// POST /api/dev/keys - dashboard only; the key is returned once.
export async function createKey(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const body = await readJson<{ name?: string; scope?: string; expiresInDays?: number | null }>(request);
  const scope: KeyScope = body.scope === "read" ? "read" : "manage";
  let expiresAt: string | null = null;
  if (body.expiresInDays !== null && body.expiresInDays !== undefined) {
    const days = Number(body.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) throw new HttpError(400, `expiresInDays must be between 1 and ${MAX_KEY_DAYS}, or null for no expiry`);
    expiresAt = new Date(deps.now().getTime() + days * 86_400_000).toISOString();
  }
  const key = newApiKey();
  const row: ApiKeyRow = {
    id: randomId(8),
    developerId: dev.id,
    name: text(body.name, 60) || "Agent",
    prefix: key.slice(0, 11),
    keyHash: await apiKeyHash(env, key),
    scope,
    createdAt: deps.now().toISOString(),
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  };
  await Db.from(env).insertApiKey(row);
  await audit(request, env, deps, dev.id, "api-key-created", `${row.name} (${scope}${expiresAt ? `, expires ${expiresAt.slice(0, 10)}` : ", no expiry"})`);
  return json({ key, apiKey: publicKey(row) }, 201);
}

// DELETE /api/dev/keys/:id - dashboard only.
export async function revokeKey(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper, id: string): Promise<Response> {
  requireSession(dev);
  const ok = await Db.from(env).revokeApiKey(id, dev.id, deps.now().toISOString());
  if (!ok) throw new HttpError(404, "unknown key");
  await audit(request, env, deps, dev.id, "api-key-revoked", id);
  return json({ ok: true });
}

// POST /api/dev/keys/revoke-all - dashboard only.
export async function revokeAllKeys(request: Request, env: Env, deps: Deps, dev: AuthedDeveloper): Promise<Response> {
  requireSession(dev);
  const count = await Db.from(env).revokeAllApiKeys(dev.id, deps.now().toISOString());
  await audit(request, env, deps, dev.id, "api-keys-revoked-all", `${count} key${count === 1 ? "" : "s"}`);
  return json({ ok: true, revoked: count });
}

// GET /api/dev/audit - recent security events for this developer.
export async function auditLog(env: Env, dev: Developer): Promise<Response> {
  return json({ events: await Db.from(env).auditFor(dev.id, 50) });
}
