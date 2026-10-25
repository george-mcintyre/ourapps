// Validation for /my-app.json, schema 1. Contract owner: @my:orchestrator.
import { SCREENSHOT_PLATFORMS, type ScreenshotPlatform } from "./screenshots.js";
import { desktopPackages, validateAppleTarget, validateDesktop, type AppleTarget, type MacTarget, type WindowsTarget } from "./desktop.js";

export const SUPPORTED_SCHEMA = 1;

export interface AppManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  minPlayers: number;
  maxPlayers: number;
  screenshots?: string[];
  // Per-platform lists; an empty list counts as not provided.
  screenshotsByPlatform?: Partial<Record<ScreenshotPlatform, string[]>>;
  install: {
    pwa: string | null;
    android: { apk: string } | null;
    // testflight is the public invitation link, null until Apple approves the first build.
    // devices is display only: which Apple devices the build targets; absent makes no claim.
    ios: { bundleId: string; testflight: string | null; devices?: IosDevice[] } | null;
    macos?: MacTarget | null;
    windows?: WindowsTarget | null;
    tvos?: AppleTarget | null;
  };
}

export type IosDevice = "iphone" | "ipad";
export const IOS_DEVICES: readonly IosDevice[] = ["iphone", "ipad"];

export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; errors: string[] };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["manifest must be a JSON object"] };

  if (input.schema !== SUPPORTED_SCHEMA) {
    return { ok: false, errors: [`unsupported schema ${String(input.schema)}; this store reads schema ${SUPPORTED_SCHEMA}`] };
  }
  if (typeof input.id !== "string" || !SLUG.test(input.id)) errors.push("id must be a lowercase slug");
  for (const key of ["name", "version", "description"] as const) {
    if (typeof input[key] !== "string" || (input[key] as string).trim() === "") errors.push(`${key} must be a non-empty string`);
  }
  if (!isHttpsUrl(input.icon)) errors.push("icon must be an https URL");
  const min = input.minPlayers;
  const max = input.maxPlayers;
  if (!Number.isInteger(min) || (min as number) < 1) errors.push("minPlayers must be an integer of at least 1");
  if (!Number.isInteger(max) || (max as number) < 1) errors.push("maxPlayers must be an integer of at least 1");
  if (Number.isInteger(min) && Number.isInteger(max) && (min as number) > (max as number)) errors.push("minPlayers must not exceed maxPlayers");

  if (input.screenshots !== undefined) {
    if (!Array.isArray(input.screenshots) || !input.screenshots.every(isHttpsUrl)) errors.push("screenshots must be a list of https URLs");
  }

  if (input.screenshotsByPlatform !== undefined) {
    const sp = input.screenshotsByPlatform;
    if (!isRecord(sp)) errors.push("screenshotsByPlatform must be an object");
    else
      for (const [key, list] of Object.entries(sp)) {
        if (!(SCREENSHOT_PLATFORMS as readonly string[]).includes(key)) errors.push(`screenshotsByPlatform keys must be ${SCREENSHOT_PLATFORMS.join(", ")} (found "${key.slice(0, 20)}")`);
        else if (!Array.isArray(list) || !list.every(isHttpsUrl)) errors.push(`screenshotsByPlatform.${key} must be a list of https URLs`);
      }
  }

  const install = input.install;
  if (!isRecord(install)) {
    errors.push("install must be an object");
    return { ok: false, errors };
  }
  const pwa = install.pwa;
  if (pwa !== null && !isHttpsUrl(pwa)) errors.push("install.pwa must be an https URL or null");

  const android = install.android;
  if (android !== null) {
    if (!isRecord(android) || !isHttpsUrl(android.apk)) errors.push("install.android.apk must be an https URL");
  }

  const ios = install.ios;
  if (ios !== null) {
    if (!isRecord(ios)) errors.push("install.ios must be an object or null");
    else {
      if (typeof ios.bundleId !== "string" || ios.bundleId === "") errors.push("install.ios.bundleId must be a string");
      if (ios.testflight !== null && ios.testflight !== undefined && !isHttpsUrl(ios.testflight)) errors.push("install.ios.testflight must be an https URL or null");
      if (ios.devices !== undefined) {
        const d = ios.devices;
        const valid = Array.isArray(d) && d.length > 0 && d.every((x) => (IOS_DEVICES as readonly unknown[]).includes(x)) && new Set(d).size === d.length;
        if (!valid) errors.push('install.ios.devices must list "iphone" and/or "ipad", each once');
      }
    }
  }
  for (const platform of ["macos", "windows"] as const) {
    if (install[platform] !== undefined && install[platform] !== null) validateDesktop(install[platform], platform, errors);
  }
  if (install.tvos !== undefined && install.tvos !== null) validateAppleTarget(install.tvos, "install.tvos", errors);
  if (pwa === null && android === null && ios === null && !install.macos && !install.windows && !install.tvos) errors.push("install needs at least one of pwa, android, ios, macos, windows, tvos");
  if (pwa === undefined || android === undefined || ios === undefined) errors.push("install must name pwa, android and ios (null when absent)");

  if (errors.length > 0) return { ok: false, errors };
  // install keeps only the fields above, so nothing else a release carries reaches an install page.
  const manifest = input as unknown as AppManifest;
  const iosIn = ios as Record<string, unknown> | null;
  manifest.install = {
    pwa: pwa as string | null,
    android: android === null ? null : { apk: (android as { apk: string }).apk },
    ios: iosIn === null ? null : { bundleId: iosIn.bundleId as string, testflight: (iosIn.testflight as string | null | undefined) ?? null, ...(iosIn.devices ? { devices: iosIn.devices as IosDevice[] } : {}) },
  };
  for (const platform of ["macos", "windows"] as const) {
    if (install[platform] === undefined) continue;
    const value = install[platform] as MacTarget | WindowsTarget | null;
    if (value === null) manifest.install[platform] = null;
    else {
      const target: MacTarget = { packages: desktopPackages(value) };
      if (platform === "macos" && "testflight" in value && value.testflight) {
        const t = value.testflight;
        target.testflight = { bundleId: t.bundleId, minOsVersion: t.minOsVersion, architectures: [...t.architectures] };
      }
      manifest.install[platform] = target;
    }
  }
  if (install.tvos !== undefined) {
    const target = install.tvos as AppleTarget | null;
    manifest.install.tvos = target === null ? null : { bundleId: target.bundleId, minOsVersion: target.minOsVersion };
  }
  return { ok: true, manifest };
}
