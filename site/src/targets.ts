import { APP_TARGET_KEYS, defaultAppTargets, type AppTarget } from "@my/store-shared";
import { api, type DevApp, type ReleaseStatus } from "./api.js";
import { html, type Raw } from "./html.js";

export const TARGET_NAMES: Record<AppTarget, string> = { ios: "iPhone and iPad", android: "Android", web: "Web", macos: "Mac", windows: "Windows", tvos: "Apple TV" };

export function targetSections(app: Partial<DevApp>): Raw {
  const targets = app.targets ?? defaultAppTargets();
  return html`${APP_TARGET_KEYS.map(target => html`<section class="card mt target-section" data-target="${target}">
    <div class="row wrap target-heading"><h2 class="grow" id="target-title-${target}">${TARGET_NAMES[target]}</h2><label class="target-switch"><input type="checkbox" role="switch" data-target-switch="${target}" aria-labelledby="target-title-${target}" ${targets[target] ? "checked" : ""} /><span>Enabled</span></label></div>
    <p class="small" data-target-message role="status" aria-live="polite"></p>
    <button class="btn sm secondary" type="button" data-target-status ${["ios", "macos", "tvos"].includes(target) ? "" : "hidden"}>Refresh status</button>
    <fieldset class="target-body" ${targets[target] ? "" : "disabled"}>
      <div data-target-release></div>
      ${target === "ios" ? html`<div id="testflight-card"></div>` : target === "macos" || target === "tvos" ? html`<div id="${target}-testflight-card"></div>` : ""}
    </fieldset></section>`)}`;
}

export function targetEnabled(root: HTMLElement, target: AppTarget): boolean {
  const input = root.querySelector<HTMLInputElement>(`[data-target-switch="${target}"]`);
  return Boolean(input?.checked && input.getAttribute("aria-busy") !== "true");
}

export function wireTargets(root: HTMLElement, app: DevApp): void {
  for (const target of APP_TARGET_KEYS) {
    const section = root.querySelector<HTMLElement>(`[data-target="${target}"]`)!;
    const input = section.querySelector<HTMLInputElement>("[data-target-switch]")!;
    const body = section.querySelector<HTMLFieldSetElement>("fieldset")!;
    const message = section.querySelector<HTMLElement>("[data-target-message]")!;
    let saved = input.checked;
    let pending = false;
    input.onclick = event => { if (pending) event.preventDefault(); };
    input.onchange = async () => {
      if (pending) { input.checked = saved; return; }
      pending = true;
      const enabled = input.checked;
      input.setAttribute("aria-busy", "true");
      input.setAttribute("aria-disabled", "true");
      body.disabled = true;
      message.textContent = "Saving...";
      try {
        const result = await api<{ targets: NonNullable<DevApp["targets"]> }>("PUT", `/api/dev/apps/${app.id}/targets/${target}`, { enabled });
        saved = result.targets[target];
        app.targets = { ...(app.targets ?? defaultAppTargets()), [target]: saved };
        message.textContent = saved ? "Enabled. Available delivery options appear on share links." : "Disabled. Setup and build history are retained.";
      } catch (error) {
        message.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        input.checked = saved;
        pending = false;
        input.removeAttribute("aria-busy");
        input.removeAttribute("aria-disabled");
        body.disabled = !saved;
      }
    };
  }
}

export function retainedTargetRelease(release: ReleaseStatus, target: AppTarget): Raw {
  if (!release.ok) return html`<p class="small">Release information unavailable.</p>`;
  const declared = release.install?.[target === "web" ? "pwa" : target];
  if (!declared) return html`<p class="small muted">No ${TARGET_NAMES[target]} delivery declared in this release.</p>`;
  return html`<dl class="kv small"><dt>Release</dt><dd>Version ${release.version}</dd><dt>Assets</dt><dd>${release.assets.join(", ") || "None"}</dd>${target === "web" && release.web ? html`<dt>Web hosting</dt><dd>${release.web.hosting === "own" ? "Developer hosted" : "Hosted by ourapps"}${release.web.ok === false ? ": not answering" : ""}</dd>` : ""}</dl>`;
}
