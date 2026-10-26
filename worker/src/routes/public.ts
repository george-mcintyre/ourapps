// Routes a friend or a visitor hits without signing in.
import { SCREENSHOT_PLATFORMS, type ScreenshotSets } from "@my/store-shared";
import { renderSVG } from "uqr";
import { Db, type AppRow, type Developer, type LinkRow } from "../db.js";
import { downloadDisposition } from "../download-filename.js";
import type { Deps, Env } from "../env.js";
import { appleClient, deliveryRevision, dlUrl, projectDelivery, signManifestLinks } from "../flow.js";
import { loadHistory } from "../history.js";
import { HttpError, json } from "../http.js";
import { verifyLink } from "../links.js";
import { loadSecrets } from "../secrets.js";
import { refreshApprovedVersions } from "../testflight.js";
import { APPLE_PLATFORMS, type ApplePlatform } from "../apple-platform.js";
import { fetchUpstream, loadManifest, resolveRelease } from "../upstream.js";
import { isBundleUrl, webAppUrl } from "../webapp.js";

export function appDetails(app: AppRow) {
  return {
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    description: app.description,
    whatsNew: app.whatsNew,
    size: app.size,
    minOs: app.minOs,
    ageNote: app.ageNote,
    privacySummary: app.privacySummary,
    iconUrl: app.iconUrl,
    screenshots: app.screenshots,
    screenshotsByPlatform: app.screenshotsByPlatform,
    updatedAt: app.updatedAt,
  };
}

export function linkActive(link: LinkRow, now: Date): boolean {
  if (link.revokedAt) return false;
  if (link.expiresAt && Date.parse(link.expiresAt) < now.getTime()) return false;
  return true;
}

// Once TestFlight is set up through ourapps, friends get its invitation only while testflight.apple.com
// says it accepts testers; until then the page offers the web version or says the iPhone version is coming.
function openInvitation(app: AppRow): string | null {
  return app.testflightLinkState === "open" ? (app.testflightUrl ?? null) : null;
}

// The version TestFlight gives friends: the newest build Apple has approved, which can be older than the release.
async function testflightVersion(env: Env, app: AppRow): Promise<string | null> {
  if (!app.ascAppId) return null;
  return (await Db.from(env).latestOpenBuild(app.id, app.platform ?? "ios"))?.version ?? null;
}

async function appleReadiness(env: Env, deps: Deps, app: AppRow) {
  const ready = {} as Record<ApplePlatform | "iosOnMac", { version: string; testflightUrl: string } | null>;
  const db = Db.from(env);
  for (const platform of APPLE_PLATFORMS) {
    const target = platform === "ios" ? app : await db.platformApp(app, platform);
    await refreshApprovedVersions(env, deps, target);
    const invitation = openInvitation(target);
    const build = invitation && target.ascAppId ? await db.latestOpenBuild(app.id, platform, deps.now().toISOString()) : null;
    ready[platform] = invitation && build ? { version: build.version, testflightUrl: invitation } : null;
  }
  if (ready.ios && app.betaGroupId && (!app.iosOnMacCheckedAt || deps.now().getTime() - Date.parse(app.iosOnMacCheckedAt) >= 60_000)) {
    let allowed: boolean | null = null;
    try {
      const client = appleClient(env, deps, await loadSecrets(env, app.developerId, ["appleIssuerId", "appleKeyId", "applePrivateKey"]));
      allowed = await client.iosOnMac(app.betaGroupId);
    } catch (err) {
      console.error(`ios-on-mac ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    app.iosOnMac = allowed === null ? null : allowed ? 1 : 0;
    app.iosOnMacCheckedAt = deps.now().toISOString();
    await db.setIosOnMac(app.id, allowed, app.iosOnMacCheckedAt);
  }
  ready.iosOnMac = ready.ios && app.iosOnMac === 1 ? ready.ios : null;
  return ready;
}

// GET /api/public/dev/:slug - a developer's opted-in apps, details only.
export async function devPage(env: Env, slug: string): Promise<Response> {
  const db = Db.from(env);
  const dev = await db.developerBySlug(slug);
  if (!dev) throw new HttpError(404, "no developer page here");
  const apps = await db.appsByDeveloper(dev.id, true);
  return json({ developer: { id: dev.id, slug: dev.slug, displayName: dev.displayName }, apps: apps.map(appDetails) });
}

// Everything an install page needs; shared by share links and the dashboard preview.
export async function buildLinkPage(env: Env, deps: Deps, app: AppRow, dev: Developer, linkId: string | null) {
  let apple = await appleReadiness(env, deps, app);
  const secrets = await loadSecrets(env, dev.id, ["githubToken"]);
  const historyPromise = loadHistory(env, deps, app, secrets.githubToken);
  // Private release assets need the token; the browser gets signed links instead.
  const sign = async (u: string) => (u && new URL(u).host === "api.github.com" ? dlUrl(env, deps, { url: u, kind: "icon", dev: dev.id }) : u);
  const signAll = (list: string[]) => Promise.all(list.map(sign));
  let manifest = null;
  let revisionManifest = null;
  let source = null;
  let release = null;
  let manifestError: string | null = null;
  try {
    release = await resolveRelease(env, deps, app, secrets.githubToken);
    source = await loadManifest(env, deps, app, secrets.githubToken);
  } catch (err) {
    manifestError = err instanceof Error ? err.message : String(err);
  }
  const targets = await Db.from(env).appTargets(app.id);
  if (source) {
    const projected = projectDelivery(source, apple, targets);
    apple = projected.apple;
    revisionManifest = projected.manifest;
    try {
      manifest = await signManifestLinks(env, deps, dev.id, projected.manifest);
      if (isBundleUrl(manifest.install.pwa, release)) manifest.install.pwa = linkId ? webAppUrl(env, linkId) : null;
      if (manifest.install.ios && app.ascAppId) manifest.install.ios.testflight = apple.ios?.testflightUrl ?? null;
      manifest.icon = await sign(manifest.icon);
      manifest.screenshots = await signAll(manifest.screenshots ?? []);
    } catch (err) {
      manifest = null;
      manifestError = err instanceof Error ? err.message : String(err);
    }
  } else {
    apple = { ios: null, macos: null, tvos: null, iosOnMac: null };
  }
  // Dashboard lists win over my-app.json lists; the page picks per platform (see pickScreenshots).
  const screenshots: ScreenshotSets = { all: app.screenshots.length > 0 ? await signAll(app.screenshots) : (manifest?.screenshots ?? []) };
  for (const p of SCREENSHOT_PLATFORMS) {
    const fromDashboard = app.screenshotsByPlatform[p] ?? [];
    const fromRelease = manifest?.screenshotsByPlatform?.[p] ?? [];
    if (fromDashboard.length > 0) screenshots[p] = await signAll(fromDashboard);
    else if (fromRelease.length > 0) screenshots[p] = await signAll(fromRelease);
  }
  return {
    deliveryRevision: await deliveryRevision(revisionManifest, apple),
    linkId,
    developer: { id: dev.id, slug: dev.slug, displayName: dev.displayName },
    app: { ...appDetails(app), iconUrl: await sign(app.iconUrl) },
    screenshots,
    release: manifest
      ? {
          version: manifest.version,
          minPlayers: manifest.minPlayers,
          maxPlayers: manifest.maxPlayers,
          install: manifest.install,
          apple,
          fallbackName: manifest.name,
          fallbackIcon: manifest.icon,
          fallbackDescription: manifest.description,
          fallbackScreenshots: manifest.screenshots ?? [],
          testflightVersion: manifest.install.ios?.testflight ? await testflightVersion(env, app) : null,
        }
      : null,
    releaseError: manifestError,
    history: await historyPromise,
  };
}

async function activeLink(env: Env, deps: Deps, linkId: string): Promise<{ link: LinkRow; app: AppRow; dev: Developer }> {
  const db = Db.from(env);
  const link = await db.linkById(linkId);
  if (!link) throw new HttpError(404, "no app behind this link");
  if (!linkActive(link, deps.now())) throw new HttpError(410, "this link is no longer active");
  const app = await db.appById(link.appId);
  const dev = app && (await db.developerById(app.developerId));
  if (!app || !dev) throw new HttpError(404, "no app behind this link");
  return { link, app, dev };
}

// GET /api/public/links/:id
export async function linkPage(env: Env, deps: Deps, linkId: string): Promise<Response> {
  const { link, app, dev } = await activeLink(env, deps, linkId);
  const page = await buildLinkPage(env, deps, app, dev, link.id);
  // The reason can name a private repository; friends only learn that no build is out yet.
  return json({ ...page, releaseError: page.releaseError ? "no published build yet" : null });
}

// GET /api/public/links/:id/latest - what an installed app polls to offer an update.
export async function linkLatest(env: Env, deps: Deps, linkId: string): Promise<Response> {
  const { app, dev } = await activeLink(env, deps, linkId);
  let apple = await appleReadiness(env, deps, app);
  const secrets = await loadSecrets(env, dev.id, ["githubToken"]);
  let release: Awaited<ReturnType<typeof resolveRelease>>;
  let manifest: Awaited<ReturnType<typeof loadManifest>>;
  try {
    release = await resolveRelease(env, deps, app, secrets.githubToken);
    manifest = await loadManifest(env, deps, app, secrets.githubToken);
  } catch (err) {
    // The detail can name a private repository, so the update check only learns that no release is readable.
    console.error(`latest ${linkId}: ${err instanceof Error ? err.message : String(err)}`);
    throw new HttpError(503, "no release of this app is available right now");
  }
  const projected = projectDelivery(manifest, apple, await Db.from(env).appTargets(app.id));
  apple = projected.apple;
  manifest = await signManifestLinks(env, deps, dev.id, projected.manifest);
  if (isBundleUrl(manifest.install.pwa, release)) manifest.install.pwa = webAppUrl(env, linkId);
  const ios = manifest.install.ios ? apple.ios : null;
  return json({
    deliveryRevision: await deliveryRevision(projected.manifest, apple),
    name: app.name || manifest.name,
    version: manifest.version,
    // TestFlight installs and updates iPhone apps; an app can open this link.
    testflightUrl: ios?.testflightUrl ?? null,
    // What TestFlight installs; compare with this on iPhone, not with version.
    testflightVersion: ios?.version ?? null,
    apple,
    android: manifest.install.android ? { apkUrl: manifest.install.android.apk } : null,
    macos: manifest.install.macos?.packages.length ? { version: manifest.version, packages: manifest.install.macos.packages } : null,
    windows: manifest.install.windows?.packages.length ? { version: manifest.version, packages: manifest.install.windows.packages } : null,
    pwa: manifest.install.pwa,
    linksExpireAt: new Date((Math.floor(deps.now().getTime() / 1000) + 60 * 60) * 1000).toISOString(),
  });
}

// GET /api/public/links/:id/qr.svg
export async function linkQr(env: Env, deps: Deps, linkId: string): Promise<Response> {
  await activeLink(env, deps, linkId);
  const svg = renderSVG(`${env.PUBLIC_ORIGIN}/l/${linkId}`, { border: 2, pixelSize: 8 });
  return new Response(svg, { status: 200, headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" } });
}

// GET /dl/:token - stream a package or image behind a signed link.
export async function serveArtefact(env: Env, deps: Deps, token: string): Promise<Response> {
  if (!env.LINK_SECRET) throw new HttpError(503, "LINK_SECRET is not configured");
  const link = await verifyLink(env.LINK_SECRET, token, deps.now());
  if (!link) throw new HttpError(403, "this link has expired; open the install page again");
  const secrets = await loadSecrets(env, link.dev, ["githubToken"]);
  const upstream = await fetchUpstream(env, deps, link.url, secrets.githubToken);
  if (!upstream.ok) throw new HttpError(502, `upstream returned ${upstream.status}`);
  if (link.kind === "icon") {
    return new Response(upstream.body, { status: 200, headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "image/png", "Cache-Control": "private, max-age=3600" } });
  }
  const contentTypes = { apk: "application/vnd.android.package-archive", dmg: "application/x-apple-diskimage", exe: "application/vnd.microsoft.portable-executable" };
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": contentTypes[link.kind], "Content-Disposition": link.kind === "apk" ? 'attachment; filename="app.apk"' : downloadDisposition(upstream.headers.get("Content-Disposition"), link.url, link.kind), "Cache-Control": "no-store" },
  });
}
