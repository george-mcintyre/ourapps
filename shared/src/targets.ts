export const APP_TARGET_KEYS = ["ios", "android", "web", "macos", "windows", "tvos"] as const;
export type AppTarget = typeof APP_TARGET_KEYS[number];
export type AppTargets = Record<AppTarget, boolean>;

export function defaultAppTargets(): AppTargets {
  return { ios: true, android: true, web: true, macos: true, windows: true, tvos: true };
}

export function isAppTarget(value: unknown): value is AppTarget {
  return typeof value === "string" && APP_TARGET_KEYS.some((key) => key === value);
}
