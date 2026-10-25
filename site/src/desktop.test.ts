import { describe, expect, it } from "vitest";
import type { DesktopPackage } from "@my/store-shared";
import type { Release, TestflightStatus } from "./api.js";
import { desktopAvailability, desktopPanel, packageLabel, readyInvitation, televisionPanel } from "./desktop.js";
import { platformDeliveryStatus, platformTestflightCard } from "./pages/dev.js";
import { availableViews, chooseView, shapeFor, showTabs } from "./views.js";

const pkg: DesktopPackage = { url: "https://ourapps.app/dl/mac", format: "dmg", architectures: ["arm64"], minOsVersion: "13", signing: "unsigned", notarization: "not-notarized" };
const release: Release = {
  version: "3.0", minPlayers: 1, maxPlayers: 8, fallbackName: "Poker Night", fallbackIcon: "", fallbackDescription: "", fallbackScreenshots: [],
  install: { ios: null, android: null, pwa: "https://example.com/", macos: { packages: [pkg, { ...pkg, url: "https://ourapps.app/dl/intel", architectures: ["x64"] }], testflight: { bundleId: "a.b", architectures: ["arm64", "x64"], minOsVersion: "13" } }, tvos: { bundleId: "a.b", minOsVersion: "18" } },
  apple: { ios: { version: "2.0", testflightUrl: "https://testflight.apple.com/join/ios" }, macos: null, tvos: null },
};

describe("desktop install choices", () => {
  it("explains missing native packages on the matching computer without inventing downloads", () => {
    const webOnly = { ...release, install: { ios: null, android: null, pwa: "https://example.com/" } };
    expect(desktopAvailability(webOnly, "macos").html).toContain("No Mac installer or ready Mac TestFlight build");
    expect(desktopAvailability(webOnly, "windows").html).toContain("No Windows installer is published");
    expect(desktopAvailability(webOnly, "windows").html).not.toContain("href=");
    expect(desktopAvailability(release, "macos").html).toBe("");
    const compatible = { ...webOnly, apple: { iosOnMac: { version: "2.0", testflightUrl: "https://testflight.apple.com/join/compatible" }, macos: null } };
    const card = desktopAvailability(compatible, "macos").html;
    expect(card).toContain("iPhone/iPad compatibility version for Apple-silicon Macs");
    expect(card).toContain("Version 2.0");
    expect(card).toContain('href="https://testflight.apple.com/join/compatible"');
    expect(card).not.toContain("Intel");
    expect(desktopAvailability(compatible, "windows").html).not.toContain("/join/compatible");
  });
  it("keeps native and web selectable, with wide previews", () => {
    const views = availableViews(release.install, () => false);
    expect(views).toEqual(["macos", "tvos", "web"]);
    expect(chooseView(views, "macos", "iPhone")).toBe("macos");
    expect(chooseView(views, "windows", "iPhone")).toBe("web");
    expect(chooseView(["macos"], "windows", "iPhone")).toBeNull();
    expect(showTabs("macos", views)).toBe(true);
    expect([shapeFor("macos"), shapeFor("windows"), shapeFor("tvos")]).toEqual(["desktop", "desktop", "desktop"]);
  });

  it("offers both Mac chips explicitly without browser inference", () => {
    const page = desktopPanel(release, "macos", true).html;
    expect(page).toContain("Apple silicon");
    expect(page).toContain("Intel");
    expect(page).toContain('href="https://ourapps.app/dl/mac"');
    expect(page).toContain('href="https://ourapps.app/dl/intel"');
    expect(page).toContain("macOS 13 or later");
    expect(page).toContain("Unsigned");
    expect(page).toContain("Not notarized");
    expect(desktopPanel(release, "macos", false).html).not.toContain('href="https://ourapps.app/dl/mac"');
    expect(packageLabel({ ...pkg, format: "exe", architectures: ["x64"] }, "windows")).toContain("Intel / AMD 64-bit");
  });

  it("does not treat declarations or another platform's readiness as an invitation", () => {
    expect(readyInvitation(release, "macos")).toBeNull();
    expect(readyInvitation(release, "tvos")).toBeNull();
    const mac = desktopPanel(release, "macos", true).html;
    const tv = televisionPanel(release, "https://example.com/l/1").html;
    expect(mac).toContain("Mac TestFlight invitation unavailable");
    expect(tv).toContain("Apple TV invitation unavailable");
    expect(mac + tv).not.toContain("/join/ios");
    const empty = desktopPanel({ ...release, install: { ...release.install, macos: { ...release.install.macos!, packages: [] } } }, "macos", true).html;
    expect(empty).toContain("No direct package available");
    expect(empty).not.toContain("Direct download version");
    expect(empty).not.toContain("Download .dmg");
  });

  it("labels signed Windows packages without promising policy acceptance", () => {
    const windows: Release = { ...release, install: { ...release.install, windows: { packages: [{ ...pkg, url: "https://ourapps.app/dl/windows", format: "exe", signing: "signed", notarization: undefined, architectures: ["x64"] }] } } };
    const page = desktopPanel(windows, "windows", true).html;
    expect(page).toContain("Signed");
    expect(page).toContain("Run the downloaded .exe installer");
    expect(page).toContain("run the new installer");
    expect(page).toContain("Installed apps, Uninstall");
    expect(page).toContain("Windows Application Control");
    expect(page).toContain("Signing does not remove those checks");
    expect(page).not.toContain("notarized");
  });

  it("shows matching approved versions separately from direct downloads", () => {
    const ready: Release = { ...release, apple: { macos: { version: "2.8", testflightUrl: "https://testflight.apple.com/join/mac" }, tvos: { version: "2.7", testflightUrl: "https://testflight.apple.com/join/tv" } } };
    const mac = desktopPanel(ready, "macos", true).html;
    expect(mac).toContain("Direct download version 3.0");
    expect(mac).toContain("TestFlight version 2.8");
    expect(mac).toContain("/join/mac");
    expect(mac).not.toContain("/join/tv");
    const tv = televisionPanel(ready, "https://example.com/l/1").html;
    expect(tv).toContain("TestFlight version 2.7");
    expect(tv).toContain("same App Store account");
    expect(tv).toContain("/join/tv");
    expect(tv).not.toContain("/join/mac");
  });

  it("offers setup before packages or invitations exist", () => {
    const status: TestflightStatus = { setUp: false, needs: "store-app", storeApp: null, stage: null, url: "https://testflight.apple.com/join/closed", invitation: { state: "not-accepting", checkedAt: null }, buildRequest: null, profile: null, contact: true, builds: [] };
    const page = platformTestflightCard({ bundleId: "a.b" } as Parameters<typeof platformTestflightCard>[0], "macos", status).html;
    expect(page).toContain("Set up Mac TestFlight");
    expect(page).toContain("existing app record");
    expect(page).toContain("Native macOS app target");
    expect(page).not.toContain('href="https://testflight.apple.com/join/closed"');
    const configured = platformTestflightCard({ bundleId: "a.b" } as Parameters<typeof platformTestflightCard>[0], "macos", { ...status, setUp: true, needs: null, profileType: "MAC_APP_STORE" }).html;
    expect(configured).toContain('value="native" selected');
    expect(configured).toContain("Apply build type and set up profile");
    expect(configured).toContain("Configured signing");
    const waiting = platformDeliveryStatus({ bundleId: "a.b" } as Parameters<typeof platformTestflightCard>[0], "macos", { ...status, setUp: true, needs: null, stage: "waiting-for-upload" }).html;
    expect(waiting).toContain("Awaiting Mac upload");
    expect(waiting).toContain("No Mac upload has arrived");
    expect(waiting).not.toContain("Apple is processing");
    const processing = platformDeliveryStatus({ bundleId: "a.b" } as Parameters<typeof platformTestflightCard>[0], "macos", { ...status, setUp: true, needs: null, stage: "processing" }).html;
    expect(processing).toContain("Apple is processing the Mac upload");
    expect(processing).not.toContain("No Mac upload has arrived");
  });
});
