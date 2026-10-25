import type { DesktopPackage } from "@my/store-shared";
import type { Release } from "./api.js";
import { html, type Raw } from "./html.js";

export const APPLE_TESTING_DOCS = "https://testflight.apple.com/";

export function desktopAvailability(release: Release, platform: "macos" | "windows"): Raw {
  const target = release.install[platform];
  if (target) return html``;
  const name = platform === "macos" ? "Mac" : "Windows";
  return html`<div class="install-card"><h3>${name} app unavailable</h3><p class="muted small">${platform === "macos" ? "No Mac installer or ready Mac TestFlight build is published for this app." : "No Windows installer is published for this app."}${release.install.pwa ? " You can use the web version below." : ""}</p></div>`;
}

export function readyInvitation(release: Release, platform: "macos" | "tvos"): { version: string; testflightUrl: string } | null {
  return release.apple?.[platform] ?? null;
}

export function packageLabel(pkg: DesktopPackage, platform: "macos" | "windows"): string {
  const names = pkg.architectures.map(a => a === "arm64" ? (platform === "macos" ? "Apple silicon" : "Arm 64-bit") : (platform === "macos" ? "Intel" : "Intel / AMD 64-bit"));
  return `${names.join(" and ")} · ${platform === "macos" ? "macOS" : "Windows"} ${pkg.minOsVersion} or later`;
}

export function desktopPanel(release: Release, platform: "macos" | "windows", matching: boolean): Raw {
  const target = release.install[platform];
  const mac = platform === "macos";
  const invite = mac ? readyInvitation(release, "macos") : null;
  const packages = target?.packages ?? [];
  return html`<div class="install-card"><h3>${mac ? "Mac" : "Windows"}</h3>
    ${packages.length ? html`<p class="muted small">Direct download version ${release.version}. Choose the package for your computer. ${mac ? "Find your chip in Apple menu, About This Mac." : "Find your system type in Settings, System, About."}</p>
    ${packages.map(pkg => html`<div class="card mt-s"><b>${packageLabel(pkg, platform)}</b><p class="small">${pkg.signing === "signed" ? "Signed" : "Unsigned"}${mac ? ` · ${pkg.notarization === "notarized" ? "Notarized" : "Not notarized"}` : ""}</p>${matching ? html`<a class="btn" href="${pkg.url}">Download .${pkg.format}</a>` : html`<p class="small muted">Open this page on ${mac ? "a Mac" : "Windows"} to download.</p>`}</div>`)}
    ${mac ? html`<p class="small mt">Open the downloaded .dmg, then drag the app to Applications. To update, quit the app and replace it in Applications with the new version. To uninstall, move the app from Applications to the Trash.</p>` : html`<p class="small mt">Run the downloaded .exe installer and follow its instructions. To update, quit the app and run the new installer. To uninstall, use Settings, Apps, Installed apps, Uninstall.</p>`}
    <p class="small muted">${mac ? "macOS" : "Windows"} security checks and your organisation's policy apply to installed apps. An unsigned app may be blocked${mac ? "." : ", including by Windows Application Control."} Signing does not remove those checks.</p>` : html`<p class="muted">No direct package available.</p>`}
    ${mac ? html`<h3 class="mt">Mac TestFlight</h3>${invite ? html`<p class="small">TestFlight version ${invite.version}${target && "testflight" in target && target.testflight ? ` · macOS ${target.testflight.minOsVersion} or later · ${target.testflight.architectures.map(a => a === "arm64" ? "Apple silicon" : "Intel").join(" and ")}` : ""}.</p><p class="small">Install TestFlight on your Mac, open the invitation on that Mac, then choose Accept and Install.</p>${matching ? html`<a class="btn" href="${invite.testflightUrl}">Open Mac invitation</a>` : html`<p class="small muted">Open this page on a Mac to accept its invitation.</p>`}<p class="small"><a href="${APPLE_TESTING_DOCS}">Apple's TestFlight instructions</a></p>` : html`<p class="muted">Mac TestFlight invitation unavailable.</p>`}` : ""}
  </div>`;
}

export function televisionPanel(release: Release, pageUrl: string): Raw {
  const invite = readyInvitation(release, "tvos");
  return html`<div class="install-card"><h3>Apple TV TestFlight</h3>
    ${release.install.tvos ? html`<p class="small">Requires tvOS ${release.install.tvos.minOsVersion} or later, and a system supported by TestFlight.</p>` : ""}
    ${invite ? html`<p class="small">TestFlight version ${invite.version}.</p><ol class="steps small"><li>Install TestFlight on your iPhone or iPad and Apple TV. Sign in to the same App Store account on both.</li><li>Open <a href="${pageUrl}">this install page</a> on the iPhone or iPad, open the Apple TV invitation below, then tap Accept.</li><li>Open TestFlight on Apple TV and install the app using the remote.</li></ol><a class="btn" href="${invite.testflightUrl}">Open Apple TV invitation on iPhone or iPad</a>` : html`<p class="muted">Apple TV invitation unavailable.</p>`}
    <p class="small"><a href="${APPLE_TESTING_DOCS}">Apple's TestFlight instructions and system requirements</a></p></div>`;
}
