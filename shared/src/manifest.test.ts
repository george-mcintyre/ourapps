import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";

const valid = {
  schema: 1,
  id: "skull",
  name: "Skull",
  version: "0.1.0",
  description: "Bluffing card game for 3-6 friends on their phones.",
  icon: "https://example.com/icon-512.png",
  minPlayers: 3,
  maxPlayers: 6,
  install: {
    pwa: null,
    android: { apk: "https://example.com/skull.apk" },
    ios: { bundleId: "com.georgemcintyre.skull", testflight: "https://testflight.apple.com/join/AbCd1234" },
  },
};

function withPatch(patch: Record<string, unknown>) {
  return { ...structuredClone(valid), ...patch };
}

describe("validateManifest", () => {
  it("accepts the reference manifest", () => {
    const result = validateManifest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe("skull");
  });

  it("rejects unknown schema versions", () => {
    const result = validateManifest(withPatch({ schema: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/unsupported schema 2/);
  });

  it("rejects non-objects", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("x").ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it("rejects a bad slug", () => {
    const result = validateManifest(withPatch({ id: "Skull App" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("id must be a lowercase slug");
  });

  it("rejects http icons", () => {
    const result = validateManifest(withPatch({ icon: "http://example.com/icon.png" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("icon must be an https URL");
  });

  it("rejects player counts out of order", () => {
    const result = validateManifest(withPatch({ minPlayers: 6, maxPlayers: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("minPlayers must not exceed maxPlayers");
  });

  it("requires at least one install path", () => {
    const result = validateManifest(withPatch({ install: { pwa: null, android: null, ios: null } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("install needs at least one of pwa, android, ios, macos, windows, tvos");
  });

  it("requires every install key to be present", () => {
    const result = validateManifest(withPatch({ install: { pwa: "https://example.com/" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/must name pwa, android and ios/);
  });

  it("accepts a pwa-only manifest", () => {
    const result = validateManifest(withPatch({ install: { pwa: "https://example.com/", android: null, ios: null } }));
    expect(result.ok).toBe(true);
  });

  it("accepts ios before the TestFlight link exists, and rejects a link that is not https", () => {
    expect(validateManifest(withPatch({ install: { pwa: null, android: null, ios: { bundleId: "a.b", testflight: null } } })).ok).toBe(true);
    const bad = validateManifest(withPatch({ install: { pwa: null, android: null, ios: { bundleId: "a.b", testflight: "http://x" } } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("install.ios.testflight must be an https URL or null");
  });

  it("passes on only the install fields it knows", () => {
    const result = validateManifest(withPatch({ install: { pwa: null, android: { apk: "https://x/a.apk", extra: 1 }, ios: { bundleId: "a.b", adhoc: "https://api.github.com/repos/o/r/releases/assets/3", devices: ["iphone"] } } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.install).toEqual({ pwa: null, android: { apk: "https://x/a.apk" }, ios: { bundleId: "a.b", testflight: null, devices: ["iphone"] } });
  });

  it("accepts optional screenshots and rejects bad ones", () => {
    expect(validateManifest(withPatch({ screenshots: ["https://example.com/1.png"] })).ok).toBe(true);
    expect(validateManifest(withPatch({ screenshots: [] })).ok).toBe(true);
    const bad = validateManifest(withPatch({ screenshots: ["http://example.com/1.png"] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("screenshots must be a list of https URLs");
    expect(validateManifest(withPatch({ screenshots: "x" })).ok).toBe(false);
  });

  it("accepts an optional ios.devices list and rejects bad ones", () => {
    const ios = (devices: unknown) => withPatch({ install: { pwa: null, android: null, ios: { bundleId: "a.b", testflight: "https://testflight.apple.com/join/x", devices } } });
    expect(validateManifest(ios(["iphone", "ipad"])).ok).toBe(true);
    expect(validateManifest(ios(["ipad"])).ok).toBe(true);
    for (const bad of [[], ["watch"], ["iphone", "iphone"], "iphone"]) {
      const r = validateManifest(ios(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain('install.ios.devices must list "iphone" and/or "ipad", each once');
    }
  });

  it("accepts screenshotsByPlatform, including empty lists, and rejects unknown keys and non-https URLs", () => {
    expect(validateManifest(withPatch({ screenshotsByPlatform: { iphone: ["https://x/1.png"], ipad: [], web: ["https://x/w.png"] } })).ok).toBe(true);
    expect(validateManifest(withPatch({ screenshotsByPlatform: {} })).ok).toBe(true);
    const badKey = validateManifest(withPatch({ screenshotsByPlatform: { iPhone: ["https://x/1.png"] } }));
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.errors[0]).toMatch(/keys must be iphone, ipad, android, web, macos, windows, tvos \(found "iPhone"\)/);
    const badUrl = validateManifest(withPatch({ screenshotsByPlatform: { android: ["http://x/1.png"] } }));
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.errors).toContain("screenshotsByPlatform.android must be a list of https URLs");
    expect(validateManifest(withPatch({ screenshotsByPlatform: ["https://x"] })).ok).toBe(false);
  });

  it("collects several errors at once", () => {
    const result = validateManifest(withPatch({ name: "", version: "", icon: "nope" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBe(3);
  });
});
