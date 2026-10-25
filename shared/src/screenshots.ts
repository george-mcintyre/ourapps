// Screenshots per platform: which list a platform's view shows.

export type ScreenshotPlatform = "iphone" | "ipad" | "android" | "web" | "macos" | "windows" | "tvos";
export const SCREENSHOT_PLATFORMS: readonly ScreenshotPlatform[] = ["iphone", "ipad", "android", "web", "macos", "windows", "tvos"];

// The general list ("all") plus the platform lists that were provided.
export type ScreenshotSets = { all: string[] } & Partial<Record<ScreenshotPlatform, string[]>>;

// Closest other platform first, so a lone set is used everywhere and shapes stay as close as possible.
const NEAREST: Record<ScreenshotPlatform, ScreenshotPlatform[]> = {
  iphone: ["android", "ipad", "web", "macos", "windows", "tvos"],
  ipad: ["iphone", "android", "web", "macos", "windows", "tvos"],
  android: ["iphone", "ipad", "web", "macos", "windows", "tvos"],
  web: ["macos", "windows", "tvos", "ipad", "iphone", "android"],
  macos: ["windows", "web", "tvos", "ipad", "iphone", "android"],
  windows: ["macos", "web", "tvos", "ipad", "android", "iphone"],
  tvos: ["web", "macos", "windows", "ipad", "iphone", "android"],
};

export interface PickedScreenshots {
  urls: string[];
  // Which list was used: the platform's own, the general one, another platform's, or none (show generated previews).
  source: ScreenshotPlatform | "all" | "none";
}

// Own list, then the general list, then the closest other platform's list; empty means generated previews.
export function pickScreenshots(platform: ScreenshotPlatform | null, sets: ScreenshotSets): PickedScreenshots {
  if (platform && sets[platform]?.length) return { urls: sets[platform]!, source: platform };
  if (sets.all.length) return { urls: sets.all, source: "all" };
  const order = platform ? NEAREST[platform] : SCREENSHOT_PLATFORMS;
  for (const other of order) if (sets[other]?.length) return { urls: sets[other]!, source: other };
  return { urls: [], source: "none" };
}
