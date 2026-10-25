import { HttpError } from "./http.js";

export type ApplePlatform = "ios" | "macos" | "tvos";
export const APPLE_PLATFORMS = ["ios", "macos", "tvos"] as const;
export function applePlatform(value: string): ApplePlatform {
  if (value === "ios" || value === "macos" || value === "tvos") return value;
  throw new HttpError(400, "unsupported Apple platform; expected ios, macos or tvos");
}
export const applePlatformName = (platform: ApplePlatform) => ({ ios: "IOS", macos: "MAC_OS", tvos: "TV_OS" })[platform];
export const profileType = (platform: ApplePlatform, nativeMac = false) => ({ ios: "IOS_APP_STORE", macos: nativeMac ? "MAC_APP_STORE" : "MAC_CATALYST_APP_STORE", tvos: "TVOS_APP_STORE" })[platform];
