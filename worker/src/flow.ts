// Signed download links and the App Store Connect client for a developer.
import type { AppManifest, AppTargets } from "@my/store-shared";
import { AppleClient } from "./apple.js";
import { sha256Hex } from "./crypto.js";
import type { DeveloperSecrets } from "./db.js";
import type { Deps, Env } from "./env.js";
import { HttpError } from "./http.js";
import { linkExpiry, signLink, type LinkPayload } from "./links.js";
import { appleReady } from "./secrets.js";

export type AppleReadiness = Record<"ios" | "macos" | "tvos" | "iosOnMac", { version: string; testflightUrl: string } | null>;

export function projectDelivery(source: AppManifest, readiness: AppleReadiness, targets: AppTargets) {
  const manifest = structuredClone(source);
  const apple = structuredClone(readiness);
  for (const target of ["ios", "android", "macos", "windows", "tvos"] as const) {
    if (!targets[target]) manifest.install[target] = null;
  }
  if (!targets.web) manifest.install.pwa = null;
  if (!manifest.install.ios) apple.ios = apple.iosOnMac = null;
  if (!manifest.install.macos?.testflight) apple.macos = null;
  if (!manifest.install.tvos) apple.tvos = null;
  if (!targets.macos) apple.iosOnMac = null;
  return { manifest, apple };
}

export async function deliveryRevision(manifest: AppManifest | null, apple: AppleReadiness): Promise<string> {
  return sha256Hex(JSON.stringify({ version: manifest?.version ?? null, install: manifest?.install ?? null, apple }));
}

export async function dlUrl(env: Env, deps: Deps, link: Omit<LinkPayload, "exp">): Promise<string> {
  if (!env.LINK_SECRET) throw new HttpError(503, "LINK_SECRET is not configured");
  const token = await signLink(env.LINK_SECRET, { ...link, exp: linkExpiry(deps.now()) });
  return `${env.PUBLIC_ORIGIN}/dl/${token}`;
}

// Downloadable packages use signed worker links.
export async function signManifestLinks(env: Env, deps: Deps, developerId: string, manifest: AppManifest): Promise<AppManifest> {
  const out: AppManifest = structuredClone(manifest);
  if (out.install.android) out.install.android.apk = await dlUrl(env, deps, { url: manifest.install.android!.apk, kind: "apk", dev: developerId });
  for (const platform of ["macos", "windows"] as const) {
    const target = out.install[platform];
    if (!target) continue;
    for (const pkg of target.packages) pkg.url = await dlUrl(env, deps, { url: pkg.url, kind: pkg.format, dev: developerId });
  }
  return out;
}

export function appleClient(env: Env, deps: Deps, secrets: DeveloperSecrets): AppleClient {
  if (!appleReady(secrets)) throw new HttpError(409, "add your App Store Connect API key in account settings first");
  return new AppleClient(env, deps, { issuerId: secrets.appleIssuerId!, keyId: secrets.appleKeyId!, privateKey: secrets.applePrivateKey! });
}
