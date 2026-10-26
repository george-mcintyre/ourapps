import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type TestflightStatus } from "./api.js";
import { saveMacBuildType } from "./pages/dev.js";

vi.mock("./api.js", async original => ({ ...await original<typeof import("./api.js")>(), api: vi.fn() }));

const request = vi.mocked(api);
const path = "/api/dev/apps/example/testflight/macos";
const native = { setUp: true, needs: null, profileType: "MAC_APP_STORE", profile: "Native profile" } as TestflightStatus;
const catalyst = { ...native, profileType: "MAC_CATALYST_APP_STORE", profile: "Catalyst profile" } as TestflightStatus;

function fixture(enabled = true) {
  const type = { value: "catalyst", dataset: { savedType: "native" } };
  const root = { querySelector: (selector: string) => selector === "[data-mac-build-type]" ? type : { checked: enabled, getAttribute: () => null } } as unknown as HTMLElement;
  return { root, type };
}

beforeEach(() => request.mockReset());

describe("Mac build type saving", () => {
  it("replaces the matching profile and confirms persisted selection", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce(native).mockResolvedValueOnce(catalyst).mockResolvedValueOnce(catalyst);
    await saveMacBuildType(root, "example");
    expect(request.mock.calls).toEqual([["GET", path], ["POST", path, { nativeMac: false, repair: true }], ["GET", path]]);
    expect(type.dataset.savedType).toBe("catalyst");
  });

  it("does nothing for an unchanged selection", async () => {
    const { root, type } = fixture();
    type.value = "native";
    await saveMacBuildType(root, "example");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a changed disabled target without setup calls", async () => {
    const { root } = fixture(false);
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("Enable the Mac target");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps initial setup explicit instead of requesting a first build", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce({ ...native, setUp: false });
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("Use Set up Mac TestFlight");
    expect(request).toHaveBeenCalledTimes(1);
    expect(type.dataset.savedType).toBe("native");
  });

  it("does not mistake an unmet prerequisite response for persistence", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce(native).mockResolvedValueOnce({ ...catalyst, needs: "review-contact" });
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("Complete the required Apple setup");
    expect(type.dataset.savedType).toBe("native");
    expect(type.value).toBe("catalyst");
  });

  it("does not trust a successful response when read-back disagrees", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce(native).mockResolvedValueOnce(catalyst).mockResolvedValueOnce(native);
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("could not be confirmed");
    expect(type.dataset.savedType).toBe("native");
  });

  it("reconciles a prior save before attempting another profile replacement", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce(catalyst);
    await saveMacBuildType(root, "example");
    expect(request.mock.calls).toEqual([["GET", path]]);
    expect(type.dataset.savedType).toBe("catalyst");
  });

  it("retains selection when status is unavailable", async () => {
    const { root, type } = fixture();
    request.mockRejectedValueOnce(new Error("Status unavailable"));
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("Status unavailable");
    expect(request).toHaveBeenCalledTimes(1);
    expect(type.dataset.savedType).toBe("native");
    expect(type.value).toBe("catalyst");
  });

  it("does not repeat a save that persisted before its status refresh failed", async () => {
    const { root, type } = fixture();
    request.mockResolvedValueOnce(native).mockRejectedValueOnce(new Error("Apple refresh failed"));
    await expect(saveMacBuildType(root, "example")).rejects.toThrow("Apple refresh failed");
    request.mockResolvedValueOnce(catalyst);
    await saveMacBuildType(root, "example");
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(type.dataset.savedType).toBe("catalyst");
  });
});
