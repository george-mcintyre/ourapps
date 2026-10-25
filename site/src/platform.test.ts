import { describe, expect, it } from "vitest";
import { appleDeviceName, detectInAppBrowser, detectPlatform } from "./platform.js";

const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const INSTAGRAM_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 Instagram 354.0.0.29.90 (iPhone12,8; iOS 18_1; en_US; scale=2.00; 828x1792; IABMV/1)";
const WHATSAPP_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Mobile/15E148 Safari/604.1 [WAiOS/2.25.31]";
const WKWEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WEBVIEW_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const FB_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("detectPlatform", () => {
  it("finds iPhone, iPad and iPadOS pretending to be a Mac", () => {
    expect(detectPlatform(SAFARI_IOS)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform(MAC, "MacIntel", 5)).toBe("ios");
    expect(detectPlatform(MAC, "MacIntel", 0)).toBe("macos");
  });

  it("finds Android and everything else", () => {
    expect(detectPlatform(CHROME_ANDROID)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
  });
});

describe("detectInAppBrowser", () => {
  it("passes real browsers", () => {
    expect(detectInAppBrowser(SAFARI_IOS, "ios")).toBeNull();
    expect(detectInAppBrowser(CHROME_IOS, "ios")).toBeNull();
    expect(detectInAppBrowser(CHROME_ANDROID, "android")).toBeNull();
    expect(detectInAppBrowser(MAC, "other")).toBeNull();
  });

  it("names known hosts", () => {
    expect(detectInAppBrowser(INSTAGRAM_IOS, "ios")).toEqual({ name: "Instagram", installWorks: false });
    expect(detectInAppBrowser(FB_ANDROID, "android")).toEqual({ name: "Facebook", installWorks: false });
    expect(detectInAppBrowser(WHATSAPP_IOS, "ios")).toEqual({ name: "WhatsApp", installWorks: true });
  });

  it("flags anonymous web views", () => {
    expect(detectInAppBrowser(WKWEBVIEW, "ios")).toEqual({ name: "this app", installWorks: false });
    expect(detectInAppBrowser(WEBVIEW_ANDROID, "android")).toEqual({ name: "this app", installWorks: false });
  });
});

describe("appleDeviceName", () => {
  it("tells iPads from iPhones, including iPadOS posing as a Mac", () => {
    expect(appleDeviceName(SAFARI_IOS)).toBe("iPhone");
    expect(appleDeviceName("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("iPad");
    expect(appleDeviceName(MAC, "MacIntel", 5)).toBe("iPad");
    expect(appleDeviceName(MAC, "MacIntel", 0)).toBe("iPhone");
  });
});
