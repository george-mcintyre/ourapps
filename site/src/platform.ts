// Which install flow to show, from the user agent alone.

export type Platform = "ios" | "android" | "macos" | "windows" | "other";

export interface InAppBrowser {
  // Human name of the host app.
  name: string;
  // Whether installs still work inside it (Safari view controller does, web views do not).
  installWorks: boolean;
}

export function detectPlatform(userAgent: string, platformHint = "", maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  // iPadOS 13+ reports as a Mac; touch points give it away.
  if (platformHint === "MacIntel" && maxTouchPoints > 1) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macos";
  if (/Windows NT/.test(userAgent)) return "windows";
  return "other";
}

// "iPad" or "iPhone" for wording; iPadOS 13+ reports as a Mac with touch points.
export function appleDeviceName(userAgent: string, platformHint = "", maxTouchPoints = 0): "iPhone" | "iPad" {
  if (/iPad/.test(userAgent)) return "iPad";
  if (platformHint === "MacIntel" && maxTouchPoints > 1 && !/iPhone|iPod/.test(userAgent)) return "iPad";
  return "iPhone";
}

// Hosts whose built-in browser cannot run an install. Order matters: first match wins.
const HOSTS: { name: string; test: RegExp; installWorks: boolean }[] = [
  { name: "Instagram", test: /Instagram/i, installWorks: false },
  { name: "Messenger", test: /FBAN\/MessengerForiOS|FB_IAB\/MESSENGER/i, installWorks: false },
  { name: "Facebook", test: /\bFB[\w_]+\/|\bFBAN\b|\bFBAV\b/i, installWorks: false },
  { name: "TikTok", test: /musical_ly|Bytedance/i, installWorks: false },
  { name: "Line", test: /\bLine\//i, installWorks: false },
  { name: "Twitter", test: /Twitter for iPhone/i, installWorks: false },
  { name: "Google", test: /\bGSA\//i, installWorks: false },
  // WhatsApp opens a Safari view controller on iOS and a Chrome custom tab on Android; installs work there.
  { name: "WhatsApp", test: /\b(WAiOS|WA4A)\//i, installWorks: true },
];

export function detectInAppBrowser(userAgent: string, platform: Platform): InAppBrowser | null {
  for (const host of HOSTS) if (host.test.test(userAgent)) return { name: host.name, installWorks: host.installWorks };
  if (platform === "ios" && !/Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent)) return { name: "this app", installWorks: false };
  if (platform === "android" && /\bwv\b/.test(userAgent)) return { name: "this app", installWorks: false };
  return null;
}
