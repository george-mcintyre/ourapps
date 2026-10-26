import { describe, expect, it } from "vitest";
import { APP_TARGET_KEYS, defaultAppTargets, isAppTarget } from "./targets.js";

describe("target selection", () => {
  it("returns independent enabled defaults for exactly the supported targets", () => {
    const first = defaultAppTargets();
    first.tvos = false;
    expect(Object.keys(first)).toEqual([...APP_TARGET_KEYS]);
    expect(Object.values(defaultAppTargets())).toEqual(Array(6).fill(true));
    for (const key of APP_TARGET_KEYS) expect(isAppTarget(key)).toBe(true);
    for (const value of [null, {}, "pwa", "IOS", "__proto__", 1]) expect(isAppTarget(value)).toBe(false);
  });
});
