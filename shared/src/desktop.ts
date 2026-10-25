export type Architecture = "arm64" | "x64";

export interface DesktopPackage {
  url: string;
  format: "dmg" | "exe";
  architectures: Architecture[];
  minOsVersion: string;
  signing: "unsigned" | "signed";
  notarization?: "notarized" | "not-notarized";
}

export interface AppleTarget {
  bundleId: string;
  minOsVersion: string;
}

export interface MacTarget {
  packages: DesktopPackage[];
  testflight?: AppleTarget & { architectures: Architecture[] };
}

export interface WindowsTarget {
  packages: DesktopPackage[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function architectures(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(a => a === "arm64" || a === "x64") && new Set(v).size === v.length;
}

export function validateAppleTarget(value: unknown, path: string, errors: string[], mac = false): void {
  if (!record(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!text(value.bundleId)) errors.push(`${path}.bundleId must be a non-empty string`);
  if (!text(value.minOsVersion)) errors.push(`${path}.minOsVersion must be a non-empty string`);
  if (mac && !architectures(value.architectures)) errors.push(`${path}.architectures must list arm64 and/or x64, each once`);
}

export function validateDesktop(value: unknown, platform: "macos" | "windows", errors: string[]): void {
  const path = `install.${platform}`;
  if (!record(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  const hasTestflight = platform === "macos" && value.testflight !== undefined;
  if (hasTestflight) validateAppleTarget(value.testflight, `${path}.testflight`, errors, true);
  if (!Array.isArray(value.packages) || (value.packages.length === 0 && !hasTestflight)) {
    errors.push(`${path}.packages must be a non-empty list unless Mac TestFlight is declared`);
    return;
  }
  for (const [i, pkg] of value.packages.entries()) {
    const item = `${path}.packages[${i}]`;
    if (!record(pkg)) {
      errors.push(`${item} must be an object`);
      continue;
    }
    let https = false;
    try { https = typeof pkg.url === "string" && new URL(pkg.url).protocol === "https:"; } catch { /* Invalid URL. */ }
    if (!https) errors.push(`${item}.url must be an https URL`);
    if (pkg.format !== (platform === "macos" ? "dmg" : "exe")) errors.push(`${item}.format must be ${platform === "macos" ? "dmg" : "exe"}`);
    if (!architectures(pkg.architectures)) errors.push(`${item}.architectures must list arm64 and/or x64, each once`);
    if (!text(pkg.minOsVersion)) errors.push(`${item}.minOsVersion must be a non-empty string`);
    if (pkg.signing !== "unsigned" && pkg.signing !== "signed") errors.push(`${item}.signing must be unsigned or signed`);
    if (platform === "macos") {
      if (pkg.notarization !== "notarized" && pkg.notarization !== "not-notarized") errors.push(`${item}.notarization must be notarized or not-notarized`);
      if (pkg.signing === "unsigned" && pkg.notarization === "notarized") errors.push(`${item} cannot be unsigned and notarized`);
    } else if (pkg.notarization !== undefined) errors.push(`${item}.notarization is only valid for macos`);
  }
}

export function desktopPackages(value: MacTarget | WindowsTarget): DesktopPackage[] {
  return value.packages.map(p => ({ url: p.url, format: p.format, architectures: [...p.architectures], minOsVersion: p.minOsVersion, signing: p.signing, ...(p.notarization ? { notarization: p.notarization } : {}) }));
}
