import { describe, expect, it } from "vitest";
import { validateDesktop } from "./desktop.js";

const pkg = { url: "https://api.github.com/repos/owner/app/releases/assets/1", format: "exe", architectures: ["arm64"], minOsVersion: "10.0.19045", signing: "unsigned" };
const check = (value: unknown, platform: "macos" | "windows" = "windows") => {
  const errors: string[] = [];
  validateDesktop(value, platform, errors);
  return errors;
};

describe("desktop package contract", () => {
  it("accepts separate architecture packages and a universal Mac image", () => {
    expect(check({ packages: [pkg, { ...pkg, architectures: ["x64"] }] })).toEqual([]);
    expect(check({ packages: [{ ...pkg, format: "dmg", architectures: ["arm64", "x64"], signing: "signed", notarization: "notarized" }] }, "macos")).toEqual([]);
  });

  it.each([
    { packages: [] },
    { packages: [{ ...pkg, architectures: [] }] },
    { packages: [{ ...pkg, architectures: ["x64", "x64"] }] },
    { packages: [{ ...pkg, architectures: ["x86"] }] },
    { packages: [{ ...pkg, url: "http://example.com/app.exe" }] },
    { packages: [{ ...pkg, format: "zip" }] },
    { packages: [{ ...pkg, signing: "trusted" }] },
    { packages: [{ ...pkg, minOsVersion: "" }] },
    { packages: [{ ...pkg, notarization: "notarized" }] },
  ])("rejects invalid Windows package metadata: %j", value => {
    expect(check(value).length).toBeGreaterThan(0);
  });

  it("requires valid Mac notarization claims", () => {
    expect(check({ packages: [{ ...pkg, format: "dmg" }] }, "macos").length).toBeGreaterThan(0);
    expect(check({ packages: [{ ...pkg, format: "dmg", notarization: "notarized" }] }, "macos").length).toBeGreaterThan(0);
    expect(check({ packages: [{ ...pkg, format: "dmg", notarization: "not-notarized" }] }, "macos")).toEqual([]);
  });

  it("accepts a package-free Mac declaration only with valid TestFlight metadata", () => {
    const testflight = { bundleId: "com.example.mac", minOsVersion: "14.0", architectures: ["arm64"] };
    expect(check({ packages: [], testflight }, "macos")).toEqual([]);
    expect(check({ packages: [], testflight: { ...testflight, architectures: [] } }, "macos").length).toBeGreaterThan(0);
    expect(check({ packages: [], testflight: null }, "macos").length).toBeGreaterThan(0);
  });
});
