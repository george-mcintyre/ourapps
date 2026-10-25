import type { AppleTarget, MacTarget, WindowsTarget, ScreenshotPlatform, ScreenshotSets } from "@my/store-shared";

// Calls to the worker on the same origin.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
  return data;
}

export interface AppDetails {
  id: string;
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
  screenshotsByPlatform?: Partial<Record<ScreenshotPlatform, string[]>>;
  updatedAt: string;
}

export interface DevApp extends AppDetails {
  repo: string;
  manifestUrl: string;
  bundleId: string;
  showOnPage: boolean;
  ascAppId?: string | null;
  testflightUrl?: string | null;
  releaseIcon?: string;
  createdAt: string;
}

export interface Install {
  macos?: MacTarget | null;
  windows?: WindowsTarget | null;
  tvos?: AppleTarget | null;
  pwa: string | null;
  android: { apk: string } | null;
  ios: { bundleId: string; testflight: string | null; devices?: ("iphone" | "ipad")[] } | null;
}

export interface Release {
  apple?: Partial<Record<"ios" | "macos" | "tvos" | "iosOnMac", { version: string; testflightUrl: string } | null>>;
  version: string;
  minPlayers: number;
  maxPlayers: number;
  install: Install;
  fallbackName: string;
  fallbackIcon: string;
  fallbackDescription: string;
  fallbackScreenshots: string[];
  // The version TestFlight installs, when it differs from the release; null when TestFlight is not open.
  testflightVersion?: string | null;
}

export interface HistoryEntry {
  version: string;
  tag: string;
  title: string;
  notes: string;
  date: string | null;
  sha: string | null;
  releaseUrl: string | null;
  commitUrl: string | null;
}

export interface LinkPage {
  linkId: string | null;
  preview?: boolean;
  developer: { id: string; slug: string; displayName: string };
  app: AppDetails;
  release: Release | null;
  releaseError: string | null;
  history: HistoryEntry[];
  // The general list and the per-platform lists; the page picks one per version.
  screenshots: ScreenshotSets;
}

export interface ShareLink {
  id: string;
  appId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface SecretStatus {
  apple: boolean;
  appleSavedAt: string | null;
  appleTeamId: string;
  appleTeamIdSavedAt: string | null;
  github: boolean;
  githubSavedAt: string | null;
  signing: SigningStatus | null;
}

export interface SigningStatus {
  name: string;
  serialNumber: string;
  expirationDate: string | null;
  createdAt: string;
}

// The result of POST /api/dev/signing: the certificate, then one line per app on TestFlight.
export interface SigningSetUp {
  signing: SigningStatus;
  apps: { id: string; name: string; error: string | null }[];
}

export interface Me {
  developer: { id: string; slug: string; displayName: string; githubLogin: string; createdAt: string; termsAcceptedVersion: string | null; termsAcceptedAt: string | null };
  authVia: "session" | "key";
  scope: "read" | "manage";
  termsVersion: string;
  secrets: SecretStatus;
  // Who Apple's TestFlight beta review contacts; null until saved.
  reviewContact: { firstName: string; lastName: string; email: string; phone: string } | null;
}

// The developer's next step before TestFlight can be set up, in the order they meet them.
export type TestflightNeed = "bundle-id" | "apple-key" | "signing" | "review-contact" | "store-app";

// After set-up: what the invitation waits for.
export type TestflightStage = "no-build" | "waiting-for-upload" | "processing" | "in-review" | "approved" | "open" | "link-closed" | "rejected" | "failed";

export interface TestflightBuild {
  version: string;
  buildNumber: string;
  state: string;
  appleState: string | null;
  message: string | null;
  uploadedAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface TestflightStatus {
  buildStatus?: BuildStatus;
  profileType?: "IOS_APP_STORE" | "MAC_CATALYST_APP_STORE" | "MAC_APP_STORE" | "TVOS_APP_STORE";
  setUp: boolean;
  // null with setUp false: ourapps can check with Apple whether the app is in App Store Connect yet.
  needs: TestflightNeed | null;
  // What to type into App Store Connect's New App form, until the app is set up.
  storeApp: { name: string; otherName: string; bundleId: string; sku: string } | null;
  stage: TestflightStage | null;
  url: string | null;
  // What testflight.apple.com shows a friend opening the invitation.
  invitation: { state: "open" | "not-accepting" | "full" | "missing" | null; checkedAt: string | null };
  buildRequest: { at: string; error: string | null } | null;
  profile: string | null;
  contact: boolean;
  builds: TestflightBuild[];
}

export interface BuildStatus {
  state: "not-started" | "requested" | "pending" | "running" | "complete" | "failed" | "cancelled" | "unavailable";
  checkedAt: string;
  requestedAt: string | null;
  reason: string | null;
  message: string | null;
  workflowName: string | null;
  runUrl: string | null;
  runId: number | null;
  runNumber: number | null;
  runAttempt: number | null;
  conclusion: string | null;
  correlation: "none" | "request-time" | "build-number" | "workflow-only" | "platform-title" | "reservation";
  platformVerified: boolean;
  uploadReceived: boolean | null;
  startedAt: string | null;
  elapsedSeconds: number | null;
  expectedSeconds: number | null;
  estimateSampleCount: number;
  estimateSource: "median-successful-job-completion" | null;
  progressPercent: number | null;
}

export interface ReleaseStatus {
  ok: boolean;
  githubToken: boolean;
  appleKey: boolean;
  tag: string | null;
  publishedAt: string | null;
  assets: string[];
  manifestUrl: string | null;
  version: string | null;
  install: { ios: boolean; android: boolean; pwa: boolean; macos?: boolean; windows?: boolean; tvos?: boolean } | null;
  // Web version: copied from web.zip by ourapps, or at the developer's own address.
  web: { hosting: "ourapps" | "own"; url: string | null; ok: boolean | null; status: number | null } | null;
  screenshots: number;
  changelog: boolean;
  errors: string[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: "read" | "manage";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface AuditEvent {
  id: number;
  event: string;
  detail: string;
  country: string | null;
  createdAt: string;
}

// Cached for the page lifetime so store pages can show the owner bar without a second round trip.
let mePromise: Promise<Me | null> | null = null;
export function whoAmI(force = false): Promise<Me | null> {
  if (!mePromise || force) {
    mePromise = api<Me>("GET", "/api/dev/me").catch(() => null);
  }
  return mePromise;
}
