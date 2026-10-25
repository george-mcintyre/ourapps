import { describe, expect, it } from "vitest";
import { downloadDisposition } from "../src/download-filename.js";

const source = "https://api.github.com/repos/o/app/releases/assets/81";

describe("desktop download filenames", () => {
  it("preserves the installer name from an asset response", () => {
    expect(downloadDisposition('attachment; filename="Poker-Night-3.0-x64.exe"', source, "exe"))
      .toBe('attachment; filename="Poker-Night-3.0-x64.exe"');
    expect(downloadDisposition("attachment; filename=Poker-Night-3.0.dmg", source, "dmg"))
      .toBe('attachment; filename="Poker-Night-3.0.dmg"');
  });

  it("prefers an encoded filename and provides an ASCII fallback", () => {
    expect(downloadDisposition("attachment; filename=app.exe; filename*=UTF-8''Jeu%20caf%C3%A9.exe", source, "exe"))
      .toBe('attachment; filename="Jeu caf_.exe"; filename*=UTF-8\'\'Jeu%20caf%C3%A9.exe');
  });

  it("uses a safe URL basename when the response has no usable name", () => {
    expect(downloadDisposition(null, "https://example.com/Poker%20Night-3.0.exe?token=private", "exe"))
      .toBe('attachment; filename="Poker Night-3.0.exe"');
    expect(downloadDisposition("attachment; filename*=UTF-8''bad%FF.exe; filename=valid.exe", source, "exe"))
      .toBe('attachment; filename="valid.exe"');
  });

  it.each([
    "../app.exe", "C:\\app.exe", "app.exe:other.exe", "app.exe\r\nX-Bad: injected", "app\u0000.exe",
    "app\u202e.exe", "app\ud800.exe", "CON.exe", "LPT1.exe", ".hidden.exe", "app.exe ", "app.html", "a".repeat(181) + ".exe",
  ])("rejects unsafe or mismatched filenames: %j", filename => {
    expect(downloadDisposition(`attachment; filename="${filename}"`, source, "exe"))
      .toBe('attachment; filename="app.exe"');
  });

  it("rejects encoded path separators and control characters", () => {
    for (const filename of ["..%2Fapp.exe", "C%3A%5Capp.exe", "app%0D%0AX-Bad%3A.exe"]) {
      expect(downloadDisposition(`attachment; filename*=UTF-8''${filename}`, source, "exe"))
        .toBe('attachment; filename="app.exe"');
    }
  });
});
