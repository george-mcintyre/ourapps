// Which versions of an app a page offers, and which one a visitor sees first.
import type { ScreenshotPlatform } from "@my/store-shared";
import type { Install } from "./api.js";
import type { Platform } from "./platform.js";

export type ViewKind = ScreenshotPlatform;
export type Shape = "phone" | "tablet" | "desktop";

export const VIEW_LABEL: Record<ViewKind, string> = { iphone: "iPhone", ipad: "iPad", android: "Android", web: "Web", macos: "Mac", windows: "Windows", tvos: "Apple TV" };
export const VIEW_ICON: Record<ViewKind, string> = { iphone: "phone", ipad: "tablet", android: "android", web: "globe", macos: "globe", windows: "globe", tvos: "globe" };

// iPhone and iPad come from the iOS build (ios.devices narrows them; without it, an iPad view
// appears only when iPad screenshots exist), Android from the APK, Web from install.pwa.
export function availableViews(install: Install | null | undefined, hasOwnScreenshots: (v: ViewKind) => boolean): ViewKind[] {
  if (!install) return [];
  const out: ViewKind[] = [];
  if (install.ios) {
    const devices = install.ios.devices;
    if (!devices || devices.includes("iphone")) out.push("iphone");
    if (devices ? devices.includes("ipad") : hasOwnScreenshots("ipad")) out.push("ipad");
  }
  if (install.android) out.push("android");
  if (install.macos) out.push("macos");
  if (install.windows) out.push("windows");
  if (install.tvos) out.push("tvos");
  if (install.pwa) out.push("web");
  return out;
}

// Prefer the matching native version, then web; television instructions are also available on computers.
// null means the device has no version (the page says so).
export function chooseView(views: ViewKind[], platform: Platform, device: "iPhone" | "iPad"): ViewKind | null {
  if (views.length === 0) return null;
  const preference: ViewKind[] =
    platform === "ios"
      ? device === "iPad"
        ? ["ipad", "iphone", "web"]
        : ["iphone", "web", "ipad"]
      : platform === "android"
        ? ["android", "web"]
        : platform === "macos"
          ? ["macos", "web", "tvos"]
          : platform === "windows"
            ? ["windows", "web", "tvos"]
            : ["web", "macos", "windows", "tvos", "iphone", "ipad", "android"];
  return preference.find((v) => views.includes(v)) ?? null;
}

// Computers offer tabs when several versions are available.
export function showTabs(platform: Platform, views: ViewKind[]): boolean {
  return ["other", "macos", "windows"].includes(platform) && views.length > 1;
}

export function shapeFor(view: ViewKind | null): Shape {
  if (view === "ipad") return "tablet";
  if (view === "web" || view === "macos" || view === "windows" || view === "tvos") return "desktop";
  return "phone";
}
