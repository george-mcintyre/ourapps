import { describe, expect, it } from "vitest";
import { APP_TARGET_KEYS, defaultAppTargets } from "@my/store-shared";
import type { LinkPage, ReleaseStatus } from "./api.js";
import { retainedTargetRelease, targetSections } from "./targets.js";
import { deliveryChanged, hasDelivery, noDelivery } from "./pages/public.js";

describe("target sections", () => {
  it("keeps six labeled switches outside disabled bodies", () => {
    const sections = targetSections({ targets: { ...defaultAppTargets(), tvos: false } }).html;
    expect(sections.match(/role="switch"/g)).toHaveLength(6);
    for (const target of APP_TARGET_KEYS) expect(sections).toContain(`aria-labelledby="target-title-${target}"`);
    expect(sections).toMatch(/data-target="tvos"[\s\S]*role="switch"[\s\S]*<fieldset class="target-body" disabled>/);
  });
  it("distinguishes unreadable and undeclared releases and retains package information", () => {
    const release = { ok: true, version: "2", assets: ["poker.dmg"], install: { macos: true } } as ReleaseStatus;
    expect(retainedTargetRelease(release, "macos").html).toContain("poker.dmg");
    expect(retainedTargetRelease(release, "macos").html).toContain("Version 2");
    expect(retainedTargetRelease(release, "windows").html).toContain("No Windows delivery declared");
    expect(retainedTargetRelease({ ...release, ok: false }, "windows").html).toContain("information unavailable");
  });
});

describe("public delivery changes", () => {
  const page = (revision: string, install: unknown) => ({ deliveryRevision: revision, release: { version: "1", install } }) as LinkPage;
  it("uses stable revisions across renewed download links and detects equal-count replacements", () => {
    expect(deliveryChanged(page("same", { android: { apk: "signed-one" } }), page("same", { android: { apk: "signed-two" } }))).toBe(false);
    expect(deliveryChanged(page("one", { windows: { packages: [{}] } }), page("two", { windows: { packages: [{}] } }))).toBe(true);
    expect(deliveryChanged(page("enabled", { pwa: "https://example.invalid" }), page("disabled", {}))).toBe(true);
  });
  it("detects a new release version at the same hosted address with an unchanged revision", () => {
    const previous = page("same", { ios: null, android: null, pwa: "https://example.invalid/play" });
    const next = { ...previous, release: { ...previous.release!, version: "2" } };
    expect(next.deliveryRevision).toBe(previous.deliveryRevision);
    expect(next.release.install).toBe(previous.release!.install);
    expect(deliveryChanged(previous, next)).toBe(true);
  });
  it("recognizes all-disabled delivery before browser guidance", () => {
    expect(hasDelivery(page("none", { ios: null, android: null, pwa: null }))).toBe(false);
    expect(hasDelivery(page("tv", { tvos: { bundleId: "a.b" } }))).toBe(true);
    expect(noDelivery().html).toContain("No install options available");
    expect(noDelivery().html).not.toMatch(/Get|Safari|Chrome|Coming soon/);
  });
});
