// Typed D1 access. Rows are snake_case in SQL and camelCase in code.
import { APP_TARGET_KEYS, isAppTarget, type AppTarget, type AppTargets, type ScreenshotPlatform } from "@my/store-shared";
import type { Env } from "./env.js";
import type { ApplePlatform } from "./apple-platform.js";
import { BuildNumberError, numericBuildNumber } from "./build-number.js";

export interface Developer {
  id: string;
  githubId: number;
  githubLogin: string;
  slug: string;
  displayName: string;
  createdAt: string;
  termsAcceptedVersion: string | null;
  termsAcceptedAt: string | null;
  // Who Apple's TestFlight beta review contacts.
  reviewFirstName?: string | null;
  reviewLastName?: string | null;
  reviewEmail?: string | null;
  reviewPhone?: string | null;
}

export interface DeveloperSecrets {
  appleIssuerId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  appleTeamId?: string;
  githubToken?: string;
  // PKCS #8 PEM of ourapps' Apple Distribution certificate for this developer.
  signingKey?: string;
  installerSigningKey?: string;
  // When each field was last saved, keyed by field name.
  savedAt?: Partial<Record<"appleIssuerId" | "appleKeyId" | "applePrivateKey" | "appleTeamId" | "githubToken" | "signingKey" | "installerSigningKey", string>>;
}

export interface BuildRunMetadata {
  runId: string;
  runAttempt: string;
}

export interface VerifiedBuildRun extends BuildRunMetadata {
  repo: string;
  createdAt: string;
  startedAt: string;
}

export interface BuildRunReservation extends VerifiedBuildRun {
  version: string;
  buildNumber: string;
  reservedAt: string;
}

// The Apple Distribution certificate ourapps created; its private key is the signingKey secret.
export interface SigningCertificateRow {
  developerId: string;
  certificateId: string;
  name: string;
  serialNumber: string;
  certificateBase64: string;
  expirationDate: string | null;
  createdAt: string;
}

export interface AppRow {
  targets?: AppTargets;
  platform?: ApplePlatform;
  nativeMac?: boolean;
  id: string;
  developerId: string;
  name: string;
  tagline: string;
  description: string;
  whatsNew: string;
  size: string;
  minOs: string;
  ageNote: string;
  privacySummary: string;
  iconUrl: string;
  screenshots: string[];
  screenshotsByPlatform: Partial<Record<ScreenshotPlatform, string[]>>;
  repo: string;
  manifestUrl: string;
  bundleId: string;
  showOnPage: boolean;
  // TestFlight: the App Store Connect app, its external group and public link, and the App Store profile.
  ascAppId?: string | null;
  betaGroupId?: string | null;
  testflightUrl?: string | null;
  storeProfileId?: string | null;
  storeProfileUuid?: string | null;
  storeProfileName?: string | null;
  storeProfileBase64?: string | null;
  // What the public invitation page said when last checked, and when.
  testflightLinkState?: LinkState | null;
  testflightCheckedAt?: string | null;
  iosOnMac?: number | null;
  iosOnMacCheckedAt?: string | null;
  // When ourapps last asked the repository for a build, and why that failed if it did.
  buildRequestedAt?: string | null;
  buildRequestError?: string | null;
  buildTokenHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkRow {
  id: string;
  appId: string;
  developerId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type KeyScope = "read" | "manage";

export interface ApiKeyRow {
  id: string;
  developerId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scope: KeyScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuditRow {
  id: number;
  developerId: string;
  event: string;
  detail: string;
  country: string | null;
  createdAt: string;
}

// A build from upload to friends: uploading (reserved at Apple), uploaded (bytes sent), processing,
// in-review (in the friends' group, with Apple's beta review), approved (being made available),
// open (friends can install it); rejected, failed, expired end it.
export type TestflightState = "uploading" | "uploaded" | "processing" | "in-review" | "approved" | "open" | "rejected" | "failed" | "expired";

// What testflight.apple.com shows for the public link: open, "isn't accepting any new testers", "is full", or no such link.
export type LinkState = "open" | "not-accepting" | "full" | "missing";

export interface TestflightBuildRow {
  platform?: ApplePlatform;
  id: number;
  appId: string;
  version: string;
  buildNumber: string;
  uploadId: string | null;
  uploadFileId: string | null;
  buildId: string | null;
  whatsNew: string | null;
  state: TestflightState;
  message: string | null;
  // Apple's external beta state, when the review was asked for, when testers were notified, and when the build expires.
  appleState?: string | null;
  submittedAt?: string | null;
  notifiedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

type Raw = Record<string, unknown>;

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function row<T>(raw: Raw | null, convert: (r: Raw) => Raw = (r) => r): T | null {
  if (!raw) return null;
  const out: Raw = {};
  for (const [k, v] of Object.entries(raw)) out[camel(k)] = v;
  return convert(out) as T;
}

const appConvert = (r: Raw): Raw => ({
  ...Object.fromEntries(Object.entries(r).filter(([key]) => !APP_TARGET_KEYS.some((target) => key === `target${target[0].toUpperCase()}${target.slice(1)}`))),
  screenshots: JSON.parse(r.screenshots as string),
  screenshotsByPlatform: JSON.parse((r.screenshotsByPlatform as string | undefined) ?? "{}"),
  showOnPage: r.showOnPage === 1,
  targets: Object.fromEntries(APP_TARGET_KEYS.map((key) => [key, r[`target${key[0].toUpperCase()}${key.slice(1)}`] === 1])),
});

export class Db {
  constructor(private d1: D1Database) {}

  static from(env: Env): Db {
    return new Db(env.DB);
  }

  // Developers

  async developerById(id: string): Promise<Developer | null> {
    return row<Developer>(await this.d1.prepare("SELECT * FROM developers WHERE id = ?").bind(id).first());
  }

  async developerByGithubId(githubId: number): Promise<Developer | null> {
    return row<Developer>(await this.d1.prepare("SELECT * FROM developers WHERE github_id = ?").bind(githubId).first());
  }

  async developerBySlug(slug: string): Promise<Developer | null> {
    return row<Developer>(await this.d1.prepare("SELECT * FROM developers WHERE slug = ?").bind(slug).first());
  }

  async insertDeveloper(dev: Developer): Promise<void> {
    await this.d1
      .prepare("INSERT INTO developers (id, github_id, github_login, slug, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(dev.id, dev.githubId, dev.githubLogin, dev.slug, dev.displayName, dev.createdAt)
      .run();
  }

  async updateDeveloper(id: string, slug: string, displayName: string): Promise<void> {
    await this.d1.prepare("UPDATE developers SET slug = ?, display_name = ? WHERE id = ?").bind(slug, displayName, id).run();
  }

  async acceptTerms(id: string, version: string, now: string): Promise<void> {
    await this.d1.prepare("UPDATE developers SET terms_accepted_version = ?, terms_accepted_at = ? WHERE id = ?").bind(version, now, id).run();
  }

  // Removes the developer and, through cascades, their secrets, sessions, keys, apps, links and TestFlight records.
  async deleteDeveloper(id: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("DELETE FROM audit_log WHERE developer_id = ?").bind(id),
      this.d1.prepare("DELETE FROM links WHERE developer_id = ?").bind(id),
      this.d1.prepare("DELETE FROM developers WHERE id = ?").bind(id),
    ]);
  }

  async secretsBlob(developerId: string): Promise<string | null> {
    const r = await this.d1.prepare("SELECT blob FROM developer_secrets WHERE developer_id = ?").bind(developerId).first<{ blob: string }>();
    return r?.blob ?? null;
  }

  async putSecretsBlob(developerId: string, blob: string, now: string): Promise<void> {
    await this.d1
      .prepare("INSERT INTO developer_secrets (developer_id, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(developer_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at")
      .bind(developerId, blob, now)
      .run();
  }

  // Sessions

  async insertSession(id: string, developerId: string, expiresAt: string): Promise<void> {
    await this.d1.prepare("INSERT INTO sessions (id, developer_id, expires_at) VALUES (?, ?, ?)").bind(id, developerId, expiresAt).run();
  }

  async sessionDeveloper(id: string, now: string): Promise<Developer | null> {
    return row<Developer>(
      await this.d1.prepare("SELECT d.* FROM sessions s JOIN developers d ON d.id = s.developer_id WHERE s.id = ? AND s.expires_at > ?").bind(id, now).first(),
    );
  }

  async renameSession(from: string, to: string): Promise<void> {
    await this.d1.prepare("UPDATE sessions SET id = ? WHERE id = ?").bind(to, from).run();
  }

  async deleteSession(id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  }

  async deleteSessionsFor(developerId: string): Promise<number> {
    const res = await this.d1.prepare("DELETE FROM sessions WHERE developer_id = ?").bind(developerId).run();
    return res.meta.changes ?? 0;
  }

  async deleteExpiredSessions(now: string): Promise<void> {
    await this.d1.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  }

  // Apps

  async appById(id: string): Promise<AppRow | null> {
    return row<AppRow>(await this.d1.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first(), appConvert);
  }

  async appTargets(id: string): Promise<AppTargets> {
    const app = await this.appById(id);
    if (!app?.targets) throw new Error("Could not read app targets.");
    return app.targets;
  }

  async setAppTarget(id: string, target: AppTarget, enabled: boolean): Promise<AppTargets> {
    if (!isAppTarget(target)) throw new Error("Unknown target.");
    await this.d1.prepare(`UPDATE apps SET target_${target} = ? WHERE id = ?`).bind(enabled ? 1 : 0, id).run();
    return this.appTargets(id);
  }

  async appsByDeveloper(developerId: string, onlyShown = false): Promise<AppRow[]> {
    const sql = `SELECT * FROM apps WHERE developer_id = ?${onlyShown ? " AND show_on_page = 1" : ""} ORDER BY name`;
    const res = await this.d1.prepare(sql).bind(developerId).all<Raw>();
    return res.results.map((r) => row<AppRow>(r, appConvert)!);
  }

  async insertApp(app: AppRow): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO apps (id, developer_id, name, tagline, description, whats_new, size, min_os, age_note, privacy_summary, icon_url, screenshots, screenshots_by_platform, repo, manifest_url, bundle_id, show_on_page, build_token_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        app.id, app.developerId, app.name, app.tagline, app.description, app.whatsNew, app.size, app.minOs, app.ageNote, app.privacySummary,
        app.iconUrl, JSON.stringify(app.screenshots), JSON.stringify(app.screenshotsByPlatform), app.repo, app.manifestUrl, app.bundleId, app.showOnPage ? 1 : 0, app.buildTokenHash, app.createdAt, app.updatedAt,
      )
      .run();
  }

  async updateApp(app: AppRow): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE apps SET name = ?, tagline = ?, description = ?, whats_new = ?, size = ?, min_os = ?, age_note = ?, privacy_summary = ?, icon_url = ?, screenshots = ?, screenshots_by_platform = ?, repo = ?, manifest_url = ?, bundle_id = ?, show_on_page = ?, build_token_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        app.name, app.tagline, app.description, app.whatsNew, app.size, app.minOs, app.ageNote, app.privacySummary, app.iconUrl, JSON.stringify(app.screenshots), JSON.stringify(app.screenshotsByPlatform),
        app.repo, app.manifestUrl, app.bundleId, app.showOnPage ? 1 : 0, app.buildTokenHash, app.updatedAt, app.id,
      )
      .run();
  }

  async rehashBuildToken(id: string, hash: string): Promise<void> {
    await this.d1.prepare("UPDATE apps SET build_token_hash = ? WHERE id = ?").bind(hash, id).run();
  }

  async deleteApp(id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM apps WHERE id = ?").bind(id).run();
  }

  // Links

  async linkById(id: string): Promise<LinkRow | null> {
    return row<LinkRow>(await this.d1.prepare("SELECT * FROM links WHERE id = ?").bind(id).first());
  }

  async linksByApp(appId: string): Promise<LinkRow[]> {
    const res = await this.d1.prepare("SELECT * FROM links WHERE app_id = ? ORDER BY created_at DESC").bind(appId).all<Raw>();
    return res.results.map((r) => row<LinkRow>(r)!);
  }

  async insertLink(link: LinkRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO links (id, app_id, developer_id, label, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(link.id, link.appId, link.developerId, link.label, link.createdAt, link.expiresAt, link.revokedAt)
      .run();
  }

  async revokeLink(id: string, now: string): Promise<void> {
    await this.d1.prepare("UPDATE links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
  }

  async renameLink(id: string, label: string): Promise<void> {
    await this.d1.prepare("UPDATE links SET label = ? WHERE id = ?").bind(label, id).run();
  }

  async deleteLink(id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  }

  // API keys

  async apiKeyByHash(hashes: string[]): Promise<ApiKeyRow | null> {
    const marks = hashes.map(() => "?").join(", ");
    return row<ApiKeyRow>(await this.d1.prepare(`SELECT * FROM api_keys WHERE key_hash IN (${marks}) AND revoked_at IS NULL`).bind(...hashes).first());
  }

  async rehashApiKey(id: string, hash: string): Promise<void> {
    await this.d1.prepare("UPDATE api_keys SET key_hash = ? WHERE id = ?").bind(hash, id).run();
  }

  async apiKeysByDeveloper(developerId: string): Promise<ApiKeyRow[]> {
    const res = await this.d1.prepare("SELECT * FROM api_keys WHERE developer_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").bind(developerId).all<Raw>();
    return res.results.map((r) => row<ApiKeyRow>(r)!);
  }

  async insertApiKey(k: ApiKeyRow): Promise<void> {
    await this.d1
      .prepare("INSERT INTO api_keys (id, developer_id, name, prefix, key_hash, scope, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(k.id, k.developerId, k.name, k.prefix, k.keyHash, k.scope, k.createdAt, k.expiresAt, k.lastUsedAt, k.revokedAt)
      .run();
  }

  async revokeAllApiKeys(developerId: string, now: string): Promise<number> {
    const res = await this.d1.prepare("UPDATE api_keys SET revoked_at = ? WHERE developer_id = ? AND revoked_at IS NULL").bind(now, developerId).run();
    return res.meta.changes ?? 0;
  }

  // Audit log

  async insertAudit(a: Omit<AuditRow, "id">): Promise<void> {
    await this.d1.prepare("INSERT INTO audit_log (developer_id, event, detail, country, created_at) VALUES (?, ?, ?, ?, ?)").bind(a.developerId, a.event, a.detail, a.country, a.createdAt).run();
  }

  async auditFor(developerId: string, limit = 50): Promise<AuditRow[]> {
    const res = await this.d1.prepare("SELECT * FROM audit_log WHERE developer_id = ? ORDER BY id DESC LIMIT ?").bind(developerId, limit).all<Raw>();
    return res.results.map((r) => row<AuditRow>(r)!);
  }

  async touchApiKey(id: string, now: string): Promise<void> {
    await this.d1.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, id).run();
  }

  async revokeApiKey(id: string, developerId: string, now: string): Promise<boolean> {
    const res = await this.d1.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND developer_id = ? AND revoked_at IS NULL").bind(now, id, developerId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  // TestFlight

  async setReviewContact(id: string, c: { firstName: string; lastName: string; email: string; phone: string }): Promise<void> {
    await this.d1.prepare("UPDATE developers SET review_first_name = ?, review_last_name = ?, review_email = ?, review_phone = ? WHERE id = ?").bind(c.firstName, c.lastName, c.email, c.phone, id).run();
  }

  async setAppTestflight(app: AppRow): Promise<void> {
    if (app.platform && app.platform !== "ios") {
      const { ascAppId, betaGroupId, testflightUrl, storeProfileId, storeProfileUuid, storeProfileName, storeProfileBase64, testflightLinkState, testflightCheckedAt, buildRequestedAt, buildRequestError, nativeMac } = app;
      const state = { ascAppId, betaGroupId, testflightUrl, storeProfileId, storeProfileUuid, storeProfileName, storeProfileBase64, testflightLinkState, testflightCheckedAt, buildRequestedAt, buildRequestError, nativeMac };
      await this.d1.prepare("INSERT INTO app_testflight_platforms (app_id, platform, state_json, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, platform) DO UPDATE SET state_json = excluded.state_json, checked_at = excluded.checked_at").bind(app.id, app.platform, JSON.stringify(state), testflightCheckedAt ?? null).run();
      return;
    }
    await this.d1
      .prepare("UPDATE apps SET asc_app_id = ?, beta_group_id = ?, testflight_url = ?, store_profile_id = ?, store_profile_uuid = ?, store_profile_name = ?, store_profile_base64 = ? WHERE id = ?")
      .bind(app.ascAppId ?? null, app.betaGroupId ?? null, app.testflightUrl ?? null, app.storeProfileId ?? null, app.storeProfileUuid ?? null, app.storeProfileName ?? null, app.storeProfileBase64 ?? null, app.id)
      .run();
  }

  async platformApp(app: AppRow, platform: ApplePlatform): Promise<AppRow> {
    if (platform === "ios") return { ...app, platform };
    const saved = await this.d1.prepare("SELECT state_json FROM app_testflight_platforms WHERE app_id = ? AND platform = ?").bind(app.id, platform).first<{ state_json: string }>();
    return { ...app, ascAppId: null, betaGroupId: null, testflightUrl: null, storeProfileId: null, storeProfileUuid: null, storeProfileName: null, storeProfileBase64: null, testflightLinkState: null, testflightCheckedAt: null, buildRequestedAt: null, buildRequestError: null, nativeMac: false, ...(saved ? JSON.parse(saved.state_json) : {}), targets: app.targets, platform };
  }

  async setLinkState(appId: string, state: LinkState | null, at: string): Promise<void> {
    await this.d1.prepare("UPDATE apps SET testflight_link_state = ?, testflight_checked_at = ? WHERE id = ?").bind(state, at, appId).run();
  }

  async setIosOnMac(appId: string, allowed: boolean | null, at: string): Promise<void> {
    await this.d1.prepare("UPDATE apps SET ios_on_mac = ?, ios_on_mac_checked_at = ? WHERE id = ?").bind(allowed === null ? null : allowed ? 1 : 0, at, appId).run();
  }

  async setBuildRequest(appId: string, at: string, error: string | null): Promise<void> {
    await this.d1.prepare("UPDATE apps SET build_requested_at = ?, build_request_error = ? WHERE id = ?").bind(at, error, appId).run();
  }

  // Least recently checked first, so the schedule reaches every app in turn.
  async appsWithTestflight(): Promise<AppRow[]> {
    const res = await this.d1.prepare("SELECT * FROM apps WHERE asc_app_id IS NOT NULL ORDER BY testflight_checked_at").all<Raw>();
    const platforms = await this.d1.prepare("SELECT app_id, platform FROM app_testflight_platforms ORDER BY checked_at").all<{ app_id: string; platform: ApplePlatform }>();
    const apps = res.results.map((r) => row<AppRow>(r, appConvert)!);
    for (const p of platforms.results) {
      const base = await this.appById(p.app_id);
      if (base) apps.push(await this.platformApp(base, p.platform));
    }
    return apps.sort((a, b) => (a.testflightCheckedAt ?? "").localeCompare(b.testflightCheckedAt ?? ""));
  }

  async insertTestflightBuild(b: Omit<TestflightBuildRow, "id">): Promise<number> {
    const res = await this.d1
      .prepare("INSERT INTO testflight_builds (app_id, version, build_number, upload_id, upload_file_id, build_id, whats_new, state, message, created_at, updated_at, platform) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(b.appId, b.version, b.buildNumber, b.uploadId, b.uploadFileId, b.buildId, b.whatsNew, b.state, b.message, b.createdAt, b.updatedAt, b.platform ?? "ios")
      .run();
    return Number(res.meta.last_row_id);
  }

  async testflightBuild(appId: string, fileId: string, platform: ApplePlatform = "ios"): Promise<TestflightBuildRow | null> {
    return row<TestflightBuildRow>(await this.d1.prepare("SELECT * FROM testflight_builds WHERE app_id = ? AND upload_file_id = ? AND platform = ?").bind(appId, fileId, platform).first());
  }

  async setUploadFile(id: number, fileId: string): Promise<void> {
    await this.d1.prepare("UPDATE testflight_builds SET upload_file_id = ? WHERE id = ?").bind(fileId, id).run();
  }

  async testflightBuilds(appId: string, limit = 5, platform: ApplePlatform = "ios"): Promise<TestflightBuildRow[]> {
    const res = await this.d1.prepare("SELECT * FROM testflight_builds WHERE app_id = ? AND platform = ? ORDER BY id DESC LIMIT ?").bind(appId, platform, limit).all<Raw>();
    return res.results.map((r) => row<TestflightBuildRow>(r)!);
  }

  async reserveBuildNumber(appId: string, platform: "macos" | "tvos", version: string, appleMaximum: number, check?: () => Promise<void>): Promise<number> {
    const local = await this.d1.prepare("SELECT MAX(CAST(build_number AS INTEGER)) AS maximum, SUM(CASE WHEN build_number = '' OR build_number GLOB '*[^0-9]*' THEN 1 ELSE 0 END) AS invalid FROM testflight_builds WHERE app_id = ? AND platform = ? AND version = ?")
      .bind(appId, platform, version).first<{ maximum: number | null; invalid: number | null }>();
    if (local?.invalid) throw new BuildNumberError("A local Apple build number is not an integer; an automatic build number cannot be reserved.");
    const seed = Math.max(numericBuildNumber(String(appleMaximum)), numericBuildNumber(String(local?.maximum ?? 0)));
    if (seed >= Number.MAX_SAFE_INTEGER) throw new BuildNumberError("The Apple build number range is exhausted; an automatic build number cannot be reserved.");
    await check?.();
    const reserved = await this.d1.prepare("INSERT INTO build_number_reservations (app_id, platform, version, counter) VALUES (?, ?, ?, ?) ON CONFLICT (app_id, platform, version) DO UPDATE SET counter = MAX(build_number_reservations.counter + 1, excluded.counter) WHERE build_number_reservations.counter < 9007199254740991 RETURNING counter")
      .bind(appId, platform, version, seed + 1).first<{ counter: number }>();
    if (!reserved || !Number.isSafeInteger(reserved.counter)) throw new BuildNumberError("The Apple build number range is exhausted; an automatic build number cannot be reserved.");
    return reserved.counter;
  }

  async buildRunReservation(appId: string, platform: ApplePlatform, repo: string, metadata: BuildRunMetadata): Promise<BuildRunReservation | null> {
    return (await this.buildRunReservations(appId, platform, repo, [metadata]))[0] ?? null;
  }

  async buildRunReservations(appId: string, platform: ApplePlatform, repo: string, runs: BuildRunMetadata[]): Promise<BuildRunReservation[]> {
    if (!runs.length) return [];
    const match = runs.map(() => "(run_id = ? AND run_attempt = ?)").join(" OR ");
    const found = await this.d1.prepare(`SELECT version, build_number AS buildNumber, github_repo AS repo, run_id AS runId, run_attempt AS runAttempt, run_created_at AS createdAt, run_started_at AS startedAt, reserved_at AS reservedAt FROM build_run_reservations WHERE app_id = ? AND platform = ? AND github_repo = ? AND (${match})`)
      .bind(appId, platform, repo.toLowerCase(), ...runs.flatMap((run) => [run.runId, run.runAttempt])).all<BuildRunReservation>();
    return found.results;
  }

  async associateBuildRun(appId: string, platform: "macos" | "tvos", version: string, buildNumber: string, run: VerifiedBuildRun, reservedAt: string): Promise<BuildRunReservation> {
    await this.d1.prepare("INSERT INTO build_run_reservations (app_id, platform, version, build_number, github_repo, run_id, run_attempt, run_created_at, run_started_at, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (app_id, platform, github_repo, run_id, run_attempt) DO NOTHING")
      .bind(appId, platform, version, buildNumber, run.repo.toLowerCase(), run.runId, run.runAttempt, run.createdAt, run.startedAt, reservedAt).run();
    const saved = await this.buildRunReservation(appId, platform, run.repo, run);
    if (!saved) throw new Error("Build run association was not saved.");
    return saved;
  }

  async hasBuildUpload(appId: string, platform: ApplePlatform, version: string, buildNumber: string, notBefore: string): Promise<boolean> {
    return Boolean(await this.d1.prepare("SELECT 1 AS found FROM testflight_builds WHERE app_id = ? AND platform = ? AND version = ? AND build_number = ? AND julianday(created_at) >= julianday(?) LIMIT 1")
      .bind(appId, platform, version, buildNumber, notBefore).first());
  }

  // Builds still on their way to friends, least recently checked first; optionally one app's only.
  async pendingTestflightBuilds(appId?: string, platform: ApplePlatform = "ios"): Promise<TestflightBuildRow[]> {
    const states = "state IN ('uploaded', 'processing', 'in-review', 'approved')";
    const res = appId
      ? await this.d1.prepare(`SELECT * FROM testflight_builds WHERE ${states} AND app_id = ? AND platform = ? ORDER BY updated_at LIMIT 5`).bind(appId, platform).all<Raw>()
      : await this.d1.prepare(`SELECT * FROM testflight_builds WHERE ${states} ORDER BY updated_at LIMIT 20`).all<Raw>();
    return res.results.map((r) => row<TestflightBuildRow>(r)!);
  }

  // The newest build friends can install through TestFlight.
  async latestOpenBuild(appId: string, platform: ApplePlatform = "ios", now = new Date().toISOString()): Promise<TestflightBuildRow | null> {
    return row<TestflightBuildRow>(await this.d1.prepare("SELECT * FROM testflight_builds WHERE app_id = ? AND platform = ? AND state = 'open' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1").bind(appId, platform, now).first());
  }

  async updateTestflightBuild(b: TestflightBuildRow): Promise<void> {
    await this.d1
      .prepare("UPDATE testflight_builds SET build_id = ?, whats_new = ?, state = ?, message = ?, apple_state = ?, submitted_at = ?, notified_at = ?, expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(b.buildId, b.whatsNew, b.state, b.message, b.appleState ?? null, b.submittedAt ?? null, b.notifiedAt ?? null, b.expiresAt ?? null, b.updatedAt, b.id)
      .run();
  }

  // Signing certificate

  async signingCertificate(developerId: string, installer = false): Promise<SigningCertificateRow | null> {
    return row<SigningCertificateRow>(await this.d1.prepare(`SELECT * FROM ${installer ? "installer_certificates" : "signing_certificates"} WHERE developer_id = ?`).bind(developerId).first());
  }

  async putSigningCertificate(c: SigningCertificateRow, installer = false): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO ${installer ? "installer_certificates" : "signing_certificates"} (developer_id, certificate_id, name, serial_number, certificate_base64, expiration_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(developer_id) DO UPDATE SET certificate_id = excluded.certificate_id, name = excluded.name, serial_number = excluded.serial_number,
         certificate_base64 = excluded.certificate_base64, expiration_date = excluded.expiration_date, created_at = excluded.created_at`,
      )
      .bind(c.developerId, c.certificateId, c.name, c.serialNumber, c.certificateBase64, c.expirationDate, c.createdAt)
      .run();
  }
}
