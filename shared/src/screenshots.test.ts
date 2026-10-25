import { describe, expect, it } from "vitest";
import { pickScreenshots, SCREENSHOT_PLATFORMS } from "./screenshots.js";

describe("pickScreenshots", () => {
  it("prefers the platform's own list, then the general list", () => {
    const sets = { all: ["g"], iphone: ["i"], ipad: [] };
    expect(pickScreenshots("iphone", sets)).toEqual({ urls: ["i"], source: "iphone" });
    expect(pickScreenshots("ipad", sets)).toEqual({ urls: ["g"], source: "all" });
    expect(pickScreenshots("web", sets)).toEqual({ urls: ["g"], source: "all" });
  });

  it("uses a lone set for every platform", () => {
    for (const only of SCREENSHOT_PLATFORMS) {
      const sets = { all: [], [only]: ["x"] };
      for (const p of SCREENSHOT_PLATFORMS) expect(pickScreenshots(p, sets).urls).toEqual(["x"]);
    }
  });

  it("falls back to the closest other platform", () => {
    const sets = { all: [], iphone: ["phone"], web: ["desktop"] };
    expect(pickScreenshots("android", sets).source).toBe("iphone");
    expect(pickScreenshots("ipad", sets).source).toBe("iphone");
    expect(pickScreenshots("web", sets).source).toBe("web");
    expect(pickScreenshots("macos", sets).source).toBe("web");
    expect(pickScreenshots("windows", sets).source).toBe("web");
    expect(pickScreenshots("tvos", sets).source).toBe("web");
    expect(pickScreenshots("macos", { all: [], windows: ["pc"], web: ["browser"] }).source).toBe("windows");
  });

  it("returns nothing when no screenshots exist anywhere", () => {
    expect(pickScreenshots("ipad", { all: [] })).toEqual({ urls: [], source: "none" });
    expect(pickScreenshots(null, { all: [], android: ["a"] })).toEqual({ urls: ["a"], source: "android" });
  });
});
