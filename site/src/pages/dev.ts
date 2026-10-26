import { SCREENSHOT_PLATFORMS, type ScreenshotPlatform } from "@my/store-shared";
import { ApiError, api, whoAmI, type ApiKey, type AuditEvent, type DevApp, type Me, type ReleaseStatus, type SecretStatus, type ShareLink, type SigningSetUp, type TestflightNeed, type TestflightStage, type TestflightStatus } from "../api.js";
import { html, raw, type Raw } from "../html.js";
import { navigate } from "../nav.js";
import { qrSvg, shareOrCopy } from "../qr.js";
import { signingRequest } from "../signing.js";
import { buildStatusCard, watchBuildStatus } from "../buildStatus.js";
import { retainedTargetRelease, targetEnabled, targetSections, wireTargets } from "../targets.js";
import { appIcon, callout, copyRow, copyText, emptyState, errorBox, fmtDate, icon, pill, statePill, toast, wireCopy, wireImages } from "../ui.js";
import { AGENT_REPO_PROMPT, AGENT_STORE_PROMPT } from "./prompts.js";
import { SOURCE_URL } from "./public.js";
import { failed, mountShell, requireMe } from "./shell.js";

type Ctx = { root: HTMLElement; me: Me };

function showError(root: HTMLElement, err: unknown, selector = "#error"): void {
  const box = root.querySelector<HTMLElement>(selector);
  if (box) box.innerHTML = errorBox(err).html;
  else toast(err instanceof Error ? err.message : String(err));
}

async function confirmAction(message: string): Promise<boolean> {
  return confirm(message);
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export async function dashboard(root: HTMLElement): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  try {
    const { apps } = await api<{ apps: DevApp[] }>("GET", "/api/dev/apps");
    const releases = await Promise.all(apps.slice(0, 6).map((a) => api<ReleaseStatus>("GET", `/api/dev/apps/${a.id}/release`).catch(() => null)));
    const links = await Promise.all(apps.map((a) => api<{ links: ShareLink[] }>("GET", `/api/dev/apps/${a.id}`).then((r) => r.links).catch(() => [] as ShareLink[])));
    const now = Date.now();
    const activeLinks = links.flat().filter((l) => !l.revokedAt && (!l.expiresAt || Date.parse(l.expiresAt) > now)).length;
    const onTestflight = apps.filter((a) => a.ascAppId).length;
    const anyRelease = releases.some((r) => r?.ok);
    const needsIos = releases.some((r) => r?.install?.ios) || apps.some((a) => a.bundleId);
    const webReleases = releases.filter((r) => r?.web);

    const steps: { done: boolean; title: string; why: string; href: string; cta: string; optional?: boolean }[] = [
      { done: true, title: "Sign in with GitHub", why: "Done. Your page is /" + me.developer.slug + ".", href: "/dev/settings", cta: "Profile" },
      { done: me.secrets.github, title: "Save a GitHub token", why: "Lets the console read releases from private repositories and ask them for fresh builds.", href: "/dev/settings#credentials", cta: "Settings" },
      { done: me.secrets.apple, title: "Save your App Store Connect key", why: needsIos ? "Needed to put iPhone apps on TestFlight." : "Only needed for iPhone apps.", href: "/dev/settings#credentials", cta: "Settings", optional: !needsIos },
      { done: Boolean(me.secrets.signing), title: "Set up iPhone signing", why: needsIos ? "One click: ourapps creates the certificate that signs iPhone builds; your repositories need no Apple secrets." : "Only needed for iPhone apps.", href: "/dev/settings#signing", cta: "Settings", optional: !needsIos },
      { done: apps.length > 0, title: "Add your first app", why: "Name, icon, a few lines, and the repository that publishes it.", href: "/dev/apps/new", cta: "Add app" },
      { done: anyRelease, title: "Publish a release the console can read", why: "A GitHub Release with my-app.json and the app files. The guide and the agent prompt show exactly how.", href: apps[0] ? `/dev/apps/${apps[0].id}` : "/dev/guide#release", cta: apps[0] ? "Check release" : "Guide" },
      ...(webReleases.length > 0
        ? [{ done: webReleases.every((r) => r?.web?.hosting === "own" && r.web.ok), title: "Host web apps on your own Cloudflare account", why: "Free and without a request limit; ourapps links to the address. A token in the app's repository lets its workflow deploy.", href: "/dev/guide#cloudflare", cta: "Guide", optional: true }]
        : []),
      { done: activeLinks > 0, title: "Create a share link", why: "Each link is private, has a QR code and can be revoked.", href: apps[0] ? `/dev/apps/${apps[0].id}/links` : "/dev/apps", cta: "Links" },
      { done: Boolean(me.reviewContact), title: "Add the TestFlight review contact", why: needsIos ? "Apple's beta review needs a name, email and phone before friends can install." : "Only needed for iPhone apps.", href: "/dev/settings#review-contact", cta: "Settings", optional: !needsIos },
      { done: apps.some((a) => a.ascAppId), title: "Put an iPhone app on TestFlight", why: needsIos ? "Friends install iPhone apps through Apple's TestFlight app; no settings to change on their phones." : "Not needed for Android or web apps.", href: apps[0] ? `/dev/apps/${apps[0].id}#testflight` : "/dev/apps", cta: "App page", optional: !needsIos },
    ];
    const required = steps.filter((s) => !s.optional);
    const doneCount = required.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);

    mountShell(
      root,
      me,
      `Hello, ${me.developer.displayName.split(" ")[0]}`,
      html`
        <div class="stats">
          <div class="stat"><b>${apps.length}</b><span>app${apps.length === 1 ? "" : "s"}</span></div>
          <div class="stat"><b>${activeLinks}</b><span>active share link${activeLinks === 1 ? "" : "s"}</span></div>
          <div class="stat"><b>${onTestflight}</b><span>app${onTestflight === 1 ? "" : "s"} on TestFlight</span></div>
        </div>

        <div class="grid-2 mt">
          <div class="card">
            <div class="row"><h2 class="grow">Setup</h2><span class="pill ${doneCount === required.length ? "ok" : "accent"}">${doneCount} of ${required.length}</span></div>
            <div class="progress"><i style="width:${Math.round((doneCount / required.length) * 100)}%"></i></div>
            ${next ? html`<p class="small muted">Next: <b>${next.title}</b>. ${next.why}</p>` : html`<p class="small muted">Everything is set up. Share links as friends arrive.</p>`}
            <ul class="checklist">
              ${steps.map((s) => html`<li class="${s.done ? "done" : ""}"><span class="tick">${s.done ? icon("check", "icon-16") : ""}</span><div class="what"><b>${s.title}${s.optional ? html` <span class="pill">optional</span>` : ""}</b><span>${s.why}</span></div>${s.done ? "" : html`<a class="btn sm ${s === next ? "" : "secondary"}" href="${s.href}">${s.cta}</a>`}</li>`)}
            </ul>
          </div>
          <div class="stack">
            <div class="card">
              <div class="row"><h2 class="grow">Apps</h2><a class="btn sm" href="/dev/apps/new">${icon("plus")} Add</a></div>
              ${apps.length === 0 ? emptyState("apps", "No apps yet", "Add the first one; it takes two minutes.", html`<a class="btn mt-s" href="/dev/apps/new">Add an app</a>`) : html`<div class="list">${apps.map((a, i) => appRow(a, releases[i] ?? null))}</div>`}
            </div>
            <div class="card">
              <h2>${icon("shield", "icon-20")} Security in one paragraph</h2>
              <p class="small muted">Your Apple key, iPhone signing key and GitHub token are encrypted per account with keys derived from a secret that lives only in the server's secret store; API keys, build tokens and sessions are stored as keyed hashes; credential changes need you in a browser. <a href="/dev/guide#security">Full description</a>, <a href="/terms">terms and data statement</a>, and recent activity under <a href="/dev/settings#security">Settings</a>.</p>
            </div>
            <div class="card">
              <h2>Learn and automate</h2>
              <p class="small muted">The <a href="/dev/guide#tldr">guide's TL;DR</a> lists the few things only you can do (sign in, tokens and keys, adding each iPhone app in App Store Connect). Everything else an agent does with the API key and prompts on the <a href="/dev/agents">agents page</a>.</p>
            </div>
          </div>
        </div>
      `,
      { sub: "Your private app store for friends and family." },
    );
  } catch (err) {
    failed(root, me, err);
  }
}

function appRow(a: DevApp, r: ReleaseStatus | null): Raw {
  const state = r === null ? pill("checking", "") : r.ok ? pill(`v${r.version}`, "ok", true) : pill("no release", "warn", true);
  return html`<li class="row"><a href="/dev/apps/${a.id}">${appIcon(a.name, a.iconUrl || a.releaseIcon, "sm")}</a><div class="grow"><a href="/dev/apps/${a.id}"><b>${a.name}</b></a><div class="small muted">${a.repo}</div></div>${state}<a class="btn sm secondary" href="/dev/apps/${a.id}/links">Links</a></li>`;
}

/* ------------------------------------------------------------------ */
/* Apps list                                                           */
/* ------------------------------------------------------------------ */

export async function appsPage(root: HTMLElement): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  try {
    const { apps } = await api<{ apps: DevApp[] }>("GET", "/api/dev/apps");
    mountShell(
      root,
      me,
      "Apps",
      apps.length === 0
        ? html`<div class="card">${emptyState("apps", "No apps yet", "An app is a name, an icon, a few lines and the GitHub repository that publishes it.", html`<a class="btn mt-s" href="/dev/apps/new">Add your first app</a>`)}</div>`
        : html`<div class="app-grid">${apps.map((a) => html`
            <div class="app-card">
              <a class="app-card-icon" href="/dev/apps/${a.id}" tabindex="-1" aria-hidden="true">${appIcon(a.name, a.iconUrl || a.releaseIcon, "md")}</a>
              <div>
                <a class="name" href="/dev/apps/${a.id}">${a.name}</a>
                <div class="meta"><span>${a.repo}</span>${a.showOnPage ? pill("on your page", "accent") : ""}</div>
                <div class="small muted" style="margin-top:4px">${a.tagline || "No tagline yet"}</div>
                <div class="actions"><a class="btn sm" href="/dev/apps/${a.id}">Edit</a><a class="btn sm secondary" href="/dev/apps/${a.id}/links">Share links</a><a class="btn sm ghost" href="/dev/apps/${a.id}/preview">Preview</a></div>
              </div>
            </div>`)}</div>`,
      { sub: "Each app has its own listing, build token and share links.", actions: html`<a class="btn" href="/dev/apps/new">${icon("plus")} Add an app</a>` },
    );
  } catch (err) {
    failed(root, me, err);
  }
}

/* ------------------------------------------------------------------ */
/* App form                                                            */
/* ------------------------------------------------------------------ */

type FieldKey = "name" | "tagline" | "iconUrl" | "description" | "whatsNew" | "privacySummary" | "size" | "minOs" | "ageNote" | "repo" | "bundleId" | "manifestUrl";
interface Field { key: FieldKey; label: string; type: "text" | "url" | "textarea"; hint?: string; placeholder?: string; required?: boolean }

const SECTIONS: { title: string; about: string; fields: Field[] }[] = [
  {
    title: "Listing",
    about: "What a friend sees first: icon, name and one line. Anything you leave blank gets a tasteful placeholder, so a bare entry still looks finished.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, placeholder: "Skull" },
      { key: "tagline", label: "Tagline", type: "text", placeholder: "Bluff your friends, lose your skull", hint: "One line under the name." },
      { key: "iconUrl", label: "Icon URL", type: "url", placeholder: "https://...", hint: "Square, 512 pixels or more. Leave blank to use the icon from my-app.json or a generated one." },
    ],
  },
  {
    title: "Story",
    about: "The text of the store page. Write like you are telling a friend what it is and why you made it.",
    fields: [
      { key: "description", label: "Description", type: "textarea", placeholder: "A quick bluffing card game for 3 to 6 people, played on your own phones around a table." },
      { key: "whatsNew", label: "What's new", type: "textarea", placeholder: "Faster dealing, bigger buttons, a rematch option.", hint: "Only shown when the latest release has no notes. Release notes from CHANGELOG.md take precedence; see the guide." },
      { key: "privacySummary", label: "Privacy summary", type: "textarea", placeholder: "Stores your chosen nickname on your phone only. Game moves go through my server and are deleted when the table closes.", hint: "In your own words: what the app collects and where it goes." },
    ],
  },
  {
    title: "Facts",
    about: "Small details shown in the Information section.",
    fields: [
      { key: "size", label: "Size", type: "text", placeholder: "24 MB" },
      { key: "minOs", label: "Compatibility", type: "text", placeholder: "iOS 17 or later, Android 10 or later" },
      { key: "ageNote", label: "Age note", type: "text", placeholder: "12+" },
    ],
  },
  {
    title: "Build and publishing",
    about: "Where the console reads releases from, and the bundle ID TestFlight needs for iPhone apps. The repository must follow the contract; the agent prompt sets it up for you.",
    fields: [
      { key: "repo", label: "GitHub repository", type: "text", required: true, placeholder: "owner/name", hint: "The latest release on this repository must carry an asset named my-app.json." },
      { key: "bundleId", label: "iPhone bundle ID", type: "text", placeholder: "com.yourname.skull", hint: "The Apple bundle identifier in your Xcode project. Also the default for Mac and Apple TV setup. ourapps creates the App ID on your Apple account when it does not exist." },
      { key: "manifestUrl", label: "my-app.json URL", type: "url", hint: "Only when the file is hosted somewhere other than the repository's releases." },
    ],
  },
];

const SHOT_FIELDS: { key: "all" | ScreenshotPlatform; label: string; hint: string }[] = [
  { key: "all", label: "All versions", hint: "Used for any version without its own list." },
  { key: "iphone", label: "iPhone", hint: "Portrait phone screenshots." },
  { key: "ipad", label: "iPad", hint: "Tablet screenshots, usually 3:4. An iPad tab appears once these exist, even without ios.devices." },
  { key: "android", label: "Android", hint: "Portrait phone screenshots from Android." },
  { key: "web", label: "Web", hint: "Browser window screenshots, usually landscape." },
  { key: "macos", label: "Mac", hint: "Mac window screenshots." },
  { key: "windows", label: "Windows", hint: "Windows window screenshots." },
  { key: "tvos", label: "Apple TV", hint: "Television screenshots, usually landscape." },
];

export async function appForm(root: HTMLElement, appId: string | null): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  let app: Partial<DevApp> = { screenshots: [], showOnPage: false };
  let links: ShareLink[] = [];
  let release: ReleaseStatus | null = null;
  if (appId) {
    try {
      const detail = await api<{ app: DevApp; links: ShareLink[] }>("GET", `/api/dev/apps/${appId}`);
      app = detail.app;
      links = detail.links;
    } catch (err) {
      return failed(root, me, err);
    }
  }
  const isNew = !appId;

  const field = (f: Field): Raw => {
    const value = (app[f.key] as string | undefined) ?? "";
    const input = f.type === "textarea"
      ? html`<textarea name="${f.key}" placeholder="${f.placeholder ?? ""}">${value}</textarea>`
      : html`<input type="${f.type}" name="${f.key}" value="${value}" placeholder="${f.placeholder ?? ""}" ${f.required ? "required" : ""} />`;
    return html`<div class="field"><label for="f-${f.key}">${f.label}${f.required ? "" : html` <span class="faint tiny">optional</span>`}</label>${input}${f.hint ? html`<div class="hint">${f.hint}</div>` : ""}</div>`;
  };

  mountShell(
    root,
    me,
    isNew ? "New app" : app.name ?? "App",
    html`
      ${!isNew ? html`<div id="release-card">${releaseCardSkeleton()}</div>${targetSections(app)}` : ""}
      <form id="app-form" class="card mt">
        ${SECTIONS.map((s) => html`<div class="form-section"><div class="about"><h3>${s.title}</h3><p>${s.about}</p></div><div>${s.fields.map(field)}</div></div>`)}
        <div class="form-section">
          <div class="about"><h3>Screenshots</h3><p>Up to 10 image URLs per list, one per line, in any proportions. Each version of the install page shows its own list; a version without one shows the general list, and if only one list exists anywhere, every version shows it. Blank lists fall back to my-app.json, then to generated previews. Release-asset links from a private repository work on the install page.</p></div>
          <div>
            ${SHOT_FIELDS.map((f) => {
              const list = f.key === "all" ? (app.screenshots ?? []) : (app.screenshotsByPlatform?.[f.key] ?? []);
              return html`<div class="field"><label for="shots-${f.key}">${f.label} <span class="faint tiny">optional</span></label><textarea id="shots-${f.key}" name="shots-${f.key}" data-shot-list="${f.key}" placeholder="https://..." rows="3">${list.join("\n")}</textarea><div class="hint">${f.hint}</div><div class="shot-previews" data-shot-previews="${f.key}">${list.map((u) => html`<img src="${u}" alt="" />`)}</div></div>`;
            })}
          </div>
        </div>
        <div class="form-section">
          <div class="about"><h3>Visibility</h3><p>Your public page at /${me.developer.slug} lists apps you switch on, details only, no install links. Share links work either way.</p></div>
          <label class="check"><input type="checkbox" name="showOnPage" ${app.showOnPage ? "checked" : ""} /> <span>Show on my public page</span></label>
        </div>
        <div id="error"></div>
        <div class="sticky-save form-actions">
          <button class="btn" type="submit">${isNew ? "Create app" : "Save changes"}</button>
          ${!isNew ? html`<a class="btn secondary" href="/dev/apps/${appId}/preview">${icon("eye")} Preview install page</a><a class="btn secondary" href="/dev/apps/${appId}/links">${icon("link")} Share links (${links.length})</a><span class="grow"></span><button class="btn ghost" type="button" id="rotate">${icon("refresh")} New build token</button><button class="btn danger" type="button" id="delete">${icon("trash")} Delete</button>` : ""}
        </div>
      </form>
      <div id="token"></div>
    `,
    {
      crumbs: html`<a href="/dev/apps">Apps</a> / ${isNew ? "New" : app.name}`,
      sub: isNew ? "Two minutes now, a finished store page straight away." : app.repo,
    },
  );

  const form = root.querySelector<HTMLFormElement>("#app-form")!;
  // Live previews; private release-asset links cannot load here (they need the token) and are dropped quietly.
  const wirePreviews = (box: HTMLElement) => box.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => img.remove(), { once: true }));
  root.querySelectorAll<HTMLTextAreaElement>("[data-shot-list]").forEach((ta) => {
    const box = root.querySelector<HTMLElement>(`[data-shot-previews="${ta.dataset.shotList}"]`)!;
    wirePreviews(box);
    ta.addEventListener("input", () => {
      const urls = ta.value.split("\n").map((u) => u.trim()).filter((u) => /^https:\/\//.test(u));
      box.innerHTML = urls.map((u) => `<img src="${u.replace(/"/g, "")}" alt="" />`).join("");
      wirePreviews(box);
    });
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body: Record<string, unknown> = {};
    for (const s of SECTIONS) for (const f of s.fields) body[f.key] = String(fd.get(f.key) ?? "");
    const lines = (key: string) => String(fd.get(`shots-${key}`) ?? "").split("\n").map((u) => u.trim()).filter(Boolean);
    body.screenshots = lines("all");
    body.screenshotsByPlatform = Object.fromEntries(SCREENSHOT_PLATFORMS.map((p) => [p, lines(p)]));
    body.showOnPage = fd.get("showOnPage") === "on";
    try {
      if (appId) {
        await api("PUT", `/api/dev/apps/${appId}`, body);
        toast("Saved");
        navigate(`/dev/apps/${appId}`);
      } else {
        const res = await api<{ app: DevApp; buildToken: string }>("POST", "/api/dev/apps", body);
        sessionStorage.setItem(`buildToken:${res.app.id}`, res.buildToken);
        navigate(`/dev/apps/${res.app.id}`);
      }
    } catch (err) {
      showError(root, err);
      root.querySelector("#error")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  root.querySelector<HTMLButtonElement>("#rotate")?.addEventListener("click", async () => {
    if (!(await confirmAction("The old token stops working at once. Continue?"))) return;
    const res = await api<{ buildToken: string }>("POST", `/api/dev/apps/${appId}/build-token`);
    showToken(root, appId!, res.buildToken);
  });
  root.querySelector<HTMLButtonElement>("#delete")?.addEventListener("click", async () => {
    if (!(await confirmAction(`Delete ${app.name} and its share links? The app stays in App Store Connect and TestFlight until you remove it there.`))) return;
    await api("DELETE", `/api/dev/apps/${appId}`);
    navigate("/dev/apps");
  });

  if (appId) {
    wireTargets(root, app as DevApp);
    void loadTestflightCard(root, me, app as DevApp);
  }
  if (appId) for (const platform of ["macos", "tvos"] as const) void loadPlatformTestflightCard(root, app as DevApp, platform);
  if (appId) {
    const fresh = sessionStorage.getItem(`buildToken:${appId}`);
    if (fresh) {
      sessionStorage.removeItem(`buildToken:${appId}`);
      showToken(root, appId, fresh);
    }
    void loadReleaseCard(root, appId, app as DevApp);
  }
}

const TF_STATE: Record<string, [string, "" | "ok" | "warn" | "bad" | "accent"]> = {
  uploading: ["uploading", "accent"],
  uploaded: ["with Apple", "accent"],
  processing: ["Apple is processing it", "accent"],
  "in-review": ["in Apple's beta review", "accent"],
  approved: ["approved", "accent"],
  open: ["friends can install it", "ok"],
  rejected: ["not approved by Apple", "bad"],
  failed: ["failed", "bad"],
  expired: ["expired", ""],
};

const STAGE_PILL: Record<TestflightStage, [string, "ok" | "warn" | "bad" | "accent"]> = {
  "no-build": ["needs a build", "warn"],
  "waiting-for-upload": ["waiting for the build", "accent"],
  processing: ["Apple is processing it", "accent"],
  "in-review": ["in Apple's beta review", "accent"],
  approved: ["approved, opening", "accent"],
  open: ["open to friends", "ok"],
  "link-closed": ["invitation not open", "warn"],
  rejected: ["not approved by Apple", "bad"],
  failed: ["build failed", "bad"],
};

// Stages that wait on Apple or the repository; the card checks again by itself while one of them lasts.
const TF_WAITING: TestflightStage[] = ["waiting-for-upload", "processing", "in-review", "approved", "link-closed"];
const TF_CHECK_MS = 60_000;
const TF_CHECK_FOR_MS = 30 * 60_000;

const ASC_APPS = "https://appstoreconnect.apple.com/apps";
// While the app is not in App Store Connect yet, the card asks Apple this often, for this long.
const TF_POLL_MS = 15_000;
const TF_POLL_FOR_MS = 20 * 60_000;

function copyable(text: string): Raw {
  return html`<code>${text}</code> <button type="button" class="btn sm ghost" data-copy="${text}">${icon("copy")} Copy</button>`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// TestFlight: the steps before it works, then the steps from the first build to an open invitation.
function testflightCard(me: Me, app: DevApp, t: TestflightStatus, checking: boolean): Raw {
  const stage = t.setUp ? (t.stage ?? "no-build") : null;
  const status = stage
    ? pill(STAGE_PILL[stage][0], STAGE_PILL[stage][1], true)
    : checking ? pill("checking with Apple", "accent") : t.needs === "store-app" ? pill("waiting for App Store Connect", "accent") : pill("not set up", "warn");
  return html`
    <div class="card mt">
      <a id="testflight"></a>
      <div class="row wrap">
        <div class="grow card-title"><h2>TestFlight</h2><p class="small faint">How friends install on iPhone and iPad.</p></div>
        ${status}
        ${t.setUp ? html`<button class="btn sm secondary" type="button" id="testflight-check">${checking ? "Checking..." : "Check with Apple"}</button>` : ""}
      </div>
      <div data-github-status>${buildStatusCard(t.buildStatus)}</div>
      ${t.setUp ? testflightProgress(app, t, stage!) : testflightSteps(me, app, t, checking)}
      <div id="testflight-result"></div>
    </div>`;
}

// After set-up: each step from the first build to friends installing, what is done, what is awaited, and from whom.
function testflightProgress(app: DevApp, t: TestflightStatus, stage: TestflightStage): Raw {
  const b = t.builds[0];
  const label = b ? `version ${b.version} (build ${b.buildNumber})` : "the build";
  const actions = `https://github.com/${app.repo}/actions`;
  const askButton = (text: string) => html`<button class="btn sm mt-s" type="button" id="tf-ask-build">${text}</button>`;
  const friends = stage === "open"
    ? html`<p class="small muted">Friends on iPhone and iPad see <b>Open the invitation</b> on the install page.</p>`
    : html`<p class="small muted">Until the invitation opens, the install page tells friends on iPhone and iPad that the app is coming soon, and offers the web version when there is one.</p>`;
  if (stage === "open") {
    return html`
      ${friends}
      <dl class="kv mt-s"><dt>Invitation</dt><dd><a href="${t.url ?? ""}" target="_blank" rel="noopener">${t.url ?? ""}</a> ${pill("accepts testers", "ok")} <span class="faint small">checked ${ago(t.invitation.checkedAt)}</span></dd><dt>Profile</dt><dd>${t.profile ?? ""}</dd></dl>
      ${buildTable(t)}
      <p class="small muted">Each build lasts 90 days; ourapps asks ${app.repo} for a fresh one two weeks before. A new version goes through Apple's beta review before friends get it; friends keep the previous build meanwhile.</p>
      ${repairLink()}`;
  }
  const order: TestflightStage[][] = [[], ["no-build", "waiting-for-upload", "failed"], ["processing"], ["in-review", "rejected"], ["approved", "link-closed"]];
  const at = order.findIndex((list) => list.includes(stage));

  let buildNow: Raw;
  if (stage === "failed") buildNow = html`${callout("bad", html`<p>Apple did not accept ${label}: ${b?.message ?? "no reason given"}.</p>`)}<p class="small">Fix the cause in the repository, then ask for a new build.</p>${askButton("Ask for a new build")}`;
  else if (t.buildRequest?.error) buildNow = html`${callout("bad", html`<p>ourapps could not ask ${app.repo} for a build: ${t.buildRequest.error}</p>`)}<p class="small">The GitHub token in <a href="/dev/settings#credentials">Settings</a> needs <b>Contents: read and write</b> on ${app.repo}. Fix it, then ask again.</p>${askButton("Ask again")}`;
  else if (stage === "waiting-for-upload") {
    const late = t.buildRequest && Date.now() - Date.parse(t.buildRequest.at) > 2 * 3_600_000;
    buildNow = html`<p>ourapps asked ${app.repo} for a build ${ago(t.buildRequest?.at)}. The release workflow runs on GitHub (<a href="${actions}" target="_blank" rel="noopener">see the run</a>) and uploads the iPhone build through ourapps; it appears here as soon as it arrives.</p>${late ? html`${callout("warn", html`<p>No upload has arrived in over two hours. Open the run on GitHub: if it failed, its log says why.</p>`)}${askButton("Ask again")}` : ""}`;
  } else buildNow = html`<p>Nothing has been uploaded yet. The app's release workflow builds the iPhone app and uploads it through ourapps. Ask it for a build now; it runs on GitHub and takes a few minutes.</p>${askButton(`Ask ${app.repo} for a build`)}`;

  const review = stage === "rejected"
    ? html`${callout("bad", html`<p>Apple's beta review did not approve ${label}. Apple's reasons are in <a href="${ASC_APPS}" target="_blank" rel="noopener">App Store Connect</a>: Apps, ${app.name}, TestFlight.</p>`)}<p class="small">Fix what Apple asks for, then ask for a new build.</p>${askButton("Ask for a new build")}`
    : html`<p>${b?.appleState === "IN_BETA_REVIEW" ? "Apple is reviewing" : "Waiting for Apple to review"} ${label}${b?.submittedAt ? `, sent ${ago(b.submittedAt)}` : ""}. Apple reviews the first build of each version before people outside your team can install it; later builds of the same version may need no review. Nothing to do: ourapps checks every ten minutes and moves on when Apple answers.</p>`;

  const closed: Record<string, string> = {
    "not-accepting": `Apple lists ${label} as ready, but the invitation still says "This beta isn't accepting any new testers right now" (checked ${ago(t.invitation.checkedAt)}). In App Store Connect: Apps, ${app.name}, TestFlight, the group Friends (ourapps), make sure the public link is on.`,
    full: `The invitation says the beta is full. In App Store Connect: Apps, ${app.name}, TestFlight, the group Friends (ourapps), raise or remove the public link's tester limit.`,
    missing: "Apple says the invitation link does not exist. Press Set up again below; ourapps turns the public link on.",
  };
  const opening = stage === "link-closed" && t.invitation.state && closed[t.invitation.state]
    ? callout("warn", html`<p>${closed[t.invitation.state]}</p>`)
    : html`<p>Apple approved ${label} and ourapps made it available to the friends' group. Waiting for the invitation page to accept testers${t.invitation.checkedAt ? html` (still closed when checked ${ago(t.invitation.checkedAt)})` : ""}.</p>`;

  const steps: { title: string; done: string | Raw; now: Raw; later: string }[] = [
    { title: "Set up with Apple", done: html`App Store profile <b>${t.profile ?? ""}</b>, the friends' group and its invitation link.`, now: html``, later: "" },
    { title: "A build from the repository", done: b ? `${label} arrived ${ago(b.uploadedAt)}.` : "Arrived.", now: buildNow, later: "The release workflow builds the iPhone app and uploads it through ourapps." },
    { title: "Apple processes the build", done: "Processed.", now: html`<p>Apple is processing ${label}, uploaded ${ago(b?.uploadedAt)}. Nothing to do: ourapps answers Apple's export compliance question for it.</p>`, later: "Apple checks every upload before it can be tested." },
    { title: "Apple's beta review", done: "Approved.", now: review, later: "Apple reviews the first build of each version." },
    { title: "Invitation opens to friends", done: "Open.", now: opening, later: "Friends can install once the invitation accepts testers." },
  ];
  return html`
    ${friends}
    <ol class="timeline">
      ${steps.map((s, i) => {
        const cls = i < at ? "done" : i === at ? "now" : "muted-step";
        const mark = cls === "done" ? icon("check", "icon-16") : String(i + 1);
        const body = cls === "done" ? html`<p>${s.done}</p>` : cls === "now" ? s.now : html`<p>${s.later}</p>`;
        return html`<li class="${cls}"><div class="mark">${mark}</div><div><h3>${s.title}</h3>${body}</div></li>`;
      })}
    </ol>
    ${t.builds.length > 1 ? buildTable(t) : ""}
    ${repairLink()}`;
}

function buildTable(t: TestflightStatus): Raw {
  if (t.builds.length === 0) return html``;
  return html`<table class="table small mt-s">${t.builds.map((b) => html`<tr><td>${b.version} (${b.buildNumber})</td><td>${pill(TF_STATE[b.state]?.[0] ?? b.state, TF_STATE[b.state]?.[1] ?? "accent")}</td><td class="faint">${b.message ?? ""} ${fmtDate(b.updatedAt, true)}</td></tr>`)}</table>`;
}

function repairLink(): Raw {
  return html`<p class="tiny faint mt-s">Something changed at Apple, such as the group or the profile being deleted? <button class="link-btn" type="button" id="tf-repair">Set up again</button></p>`;
}

// Every step before TestFlight works, in order: done ones say what was saved, the current one says
// what to do, later ones say what they are for.
function testflightSteps(me: Me, app: DevApp, t: TestflightStatus, checking: boolean): Raw {
  const c = me.reviewContact;
  const steps: { need: TestflightNeed | null; title: string; done: boolean; doneText: Raw | string; about: string; todo: () => Raw }[] = [
    {
      need: "bundle-id",
      title: "iPhone bundle ID",
      done: Boolean(app.bundleId),
      doneText: html`<code>${app.bundleId}</code>`,
      about: "The identifier of the iPhone app, from its Xcode project.",
      todo: () => html`<p>Type the app's bundle identifier into <b>iPhone bundle ID</b> under Build and publishing below, then press <b>Save changes</b>. Xcode shows it on the app target's <b>General</b> tab, for example <code>com.yourname.skull</code>.</p>`,
    },
    {
      need: "apple-key",
      title: "App Store Connect API key",
      done: me.secrets.apple,
      doneText: "Saved in Settings.",
      about: "Lets ourapps work with Apple for you.",
      todo: () => html`<p>ourapps talks to Apple with this key. <a href="/dev/guide#apple-key">Make one</a> in App Store Connect, then save it under <a href="/dev/settings#credentials">Settings</a>.</p>`,
    },
    {
      need: "signing",
      title: "iPhone signing",
      done: Boolean(me.secrets.signing),
      doneText: me.secrets.signing?.name ?? "Set up.",
      about: "The certificate that signs each iPhone build.",
      todo: () => html`<p>Open <a href="/dev/settings#signing">Settings</a> and press <b>Set up iPhone signing</b>. ourapps makes the certificate in a few seconds.</p>`,
    },
    {
      need: "review-contact",
      title: "Beta review contact",
      done: t.contact,
      doneText: c ? `${c.firstName} ${c.lastName}, ${c.email}` : "Saved.",
      about: "Who Apple contacts about its beta review.",
      todo: () => reviewContactForm(me),
    },
    {
      need: "store-app",
      title: "Add the app in App Store Connect",
      done: false,
      doneText: "",
      about: "Two minutes on Apple's website: the one step ourapps cannot do for you.",
      todo: () => storeAppSteps(t),
    },
    {
      need: null,
      title: "ourapps finishes the set-up",
      done: false,
      doneText: "",
      about: "The App Store profile, the friends' group and its invitation link.",
      todo: () => html`<p>${checking ? "Checking status..." : "Press Check now to finish setup with Apple."} Setup makes the App Store profile and the friends' group with its invitation link, and gives Apple the beta review details.</p>${checking ? "" : html`<button class="btn sm mt-s" type="button" id="testflight-check">Check now</button>`}`,
    },
  ];
  return html`
    <p class="small muted">Only for apps that run on iPhone or iPad. Friends install them through Apple's free TestFlight app. These steps are needed once per app; ourapps does everything after them.</p>
    <ol class="timeline">
      ${steps.map((s, i) => {
        const current = s.need === t.needs;
        const cls = current ? "now" : s.done ? "done" : "muted-step";
        const mark = cls === "done" ? icon("check", "icon-16") : current && checking ? html`<span class="spinner"></span>` : String(i + 1);
        return html`<li class="${cls}"><div class="mark">${mark}</div><div><h3>${s.title}</h3>${current ? s.todo() : html`<p>${s.done ? s.doneText : s.about}</p>`}</div></li>`;
      })}
    </ol>`;
}

function reviewContactForm(me: Me): Raw {
  const c = me.reviewContact;
  return html`
    <p>Apple reviews the first build of each version before friends can install it, and needs someone to contact with questions. Saved once for all your apps.</p>
    <form id="tf-contact" class="mt-s">
      <div class="row wrap">
        <div class="field grow"><label>First name</label><input type="text" name="firstName" value="${c?.firstName ?? ""}" maxlength="60" required /></div>
        <div class="field grow"><label>Last name</label><input type="text" name="lastName" value="${c?.lastName ?? ""}" maxlength="60" required /></div>
      </div>
      <div class="row wrap">
        <div class="field grow"><label>Email</label><input type="email" name="email" value="${c?.email ?? ""}" maxlength="120" required /></div>
        <div class="field grow"><label>Phone, with country code</label><input type="tel" name="phone" value="${c?.phone ?? ""}" maxlength="40" placeholder="+44 7700 900123" required /></div>
      </div>
      <button class="btn sm" type="submit">Save and continue</button>
    </form>`;
}

// App Store Connect's New App form, field by field, with what to type.
function storeAppSteps(t: TestflightStatus): Raw {
  const f = t.storeApp!;
  return html`
    <p>Apple lets only you add an app to App Store Connect. It takes about two minutes, once per app.</p>
    <ol class="steps small">
      <li>Open <a href="${ASC_APPS}" target="_blank" rel="noopener">Apps in App Store Connect</a> and sign in with your Apple developer account.</li>
      <li>Click the <b>+</b> button at the top left, then <b>New App</b>.</li>
      <li><b>Platforms</b>: tick <b>iOS</b>.</li>
      <li><b>Name</b>: ${copyable(f.name)}<div class="small muted">If Apple says the name is already in use (another developer may have it), use ${copyable(f.otherName)} instead. Home screens still show the app's own name.</div></li>
      <li><b>Primary Language</b>: the language the app is written in, for example English (U.K.).</li>
      <li><b>Bundle ID</b>: open the list and choose the entry with <code>${f.bundleId}</code>. ourapps has added it to your Apple account; if it is missing, reload the page in App Store Connect.</li>
      <li><b>SKU</b>: ${copyable(f.sku)}<div class="small muted">Any short code of your own; friends never see it.</div></li>
      <li><b>User Access</b>: choose <b>Full Access</b>.</li>
      <li>Click <b>Create</b>.</li>
    </ol>
    <p class="small muted">If App Store Connect asks for an updated agreement to be accepted, the account holder accepts it under <b>Business</b> first; Apple allows no new apps until then.</p>
    <p class="small" id="tf-poll-note">While this page is open it checks with Apple every 15 seconds, and moves on by itself once the app is there.</p>
    <button class="btn sm" type="button" id="testflight-check">Check now</button>`;
}

async function loadTestflightCard(root: HTMLElement, me: Me, app: DevApp): Promise<void> {
  const box = root.querySelector<HTMLElement>("#testflight-card");
  if (!box) return;
  const path = `/api/dev/apps/${app.id}/testflight`;
  let t: TestflightStatus;
  try {
    t = await api<TestflightStatus>("GET", path);
  } catch (err) {
    box.innerHTML = errorBox(err).html;
    const retry = root.querySelector<HTMLButtonElement>('[data-target="ios"] [data-target-status]');
    if (retry) retry.onclick = () => void loadTestflightCard(root, me, app);
    return;
  }
  let shown = "";
  let busy = false;
  let lastCheck = 0;
  let timer: number | undefined;
  let pollUntil = Date.now() + (t.setUp ? TF_CHECK_FOR_MS : TF_POLL_FOR_MS);
  // Runs one change at Apple or GitHub and shows the answer; the button shows it is busy meanwhile.
  const act = async (button: HTMLButtonElement, busyText: string, call: () => Promise<TestflightStatus>, done: string) => {
    if (!targetEnabled(root, "ios")) return;
    button.disabled = true;
    button.textContent = busyText;
    try {
      t = await call();
      shown = "";
      render();
      toast(done);
      pollUntil = Date.now() + TF_CHECK_FOR_MS;
      schedule();
    } catch (err) {
      button.disabled = false;
      shown = "";
      render();
      showError(root, err, "#testflight-result");
    }
  };

  // Draws the card again only when something on it changed, so typing in the form is never lost.
  const render = (checking = false) => {
    const key = JSON.stringify([t, me.secrets.apple, Boolean(me.secrets.signing), checking]);
    if (key === shown) return;
    shown = key;
    box.innerHTML = testflightCard(me, app, t, checking).html;
    wireCopy(box);
    box.querySelector<HTMLButtonElement>("#testflight-check")?.addEventListener("click", () => void check(true));
    const ask = box.querySelector<HTMLButtonElement>("#tf-ask-build");
    if (ask) ask.onclick = () => void act(ask, "Asking...", () => api<TestflightStatus>("POST", `${path}/build`), "Asked the repository for a build");
    const repair = box.querySelector<HTMLButtonElement>("#tf-repair");
    if (repair) repair.onclick = () => void act(repair, "Setting up...", () => api<TestflightStatus>("POST", path, { repair: true }), "Set up again");
    const form = box.querySelector<HTMLFormElement>("#tf-contact");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!targetEnabled(root, "ios")) return;
        const fd = new FormData(form);
        const contact = { firstName: String(fd.get("firstName") ?? ""), lastName: String(fd.get("lastName") ?? ""), email: String(fd.get("email") ?? ""), phone: String(fd.get("phone") ?? "") };
        const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
        submit.disabled = true;
        submit.textContent = "Saving...";
        try {
          const saved = await api<{ reviewContact: Me["reviewContact"] }>("PUT", "/api/dev/review-contact", contact);
          me.reviewContact = saved.reviewContact;
          toast("Contact saved");
          lastCheck = 0;
          await check(false);
        } catch (err) {
          submit.disabled = false;
          submit.textContent = "Save and continue";
          showError(root, err, "#testflight-result");
        }
      };
    }
  };
  const stop = () => {
    clearTimeout(timer);
    removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
  // Before set-up: waiting for the app in App Store Connect. After: waiting on the repository or Apple.
  const schedule = () => {
    clearTimeout(timer);
    const waiting = t.setUp ? TF_WAITING.includes(t.stage ?? "no-build") : t.needs === "store-app";
    if (!waiting) return;
    if (Date.now() > pollUntil) {
      const note = box.querySelector<HTMLElement>("#tf-poll-note");
      if (note) note.textContent = "Stopped checking by itself after 20 minutes. Press Check now once the app is in App Store Connect.";
      return;
    }
    timer = window.setTimeout(() => (document.visibilityState === "visible" ? void check(false) : schedule()), t.setUp ? TF_CHECK_MS : TF_POLL_MS);
  };
  const check = async (byHand: boolean) => {
    if (!box.isConnected) return stop();
    if (busy || (!byHand && Date.now() - lastCheck < 5000)) return;
    busy = true;
    lastCheck = Date.now();
    const wasSetUp = t.setUp;
    const wasStage = t.stage;
    const button = box.querySelector<HTMLButtonElement>("#testflight-check");
    if (button) {
      button.disabled = true;
      button.textContent = "Checking...";
    }
    if (!t.setUp && t.needs === null) render(true);
    try {
      if (byHand && !targetEnabled(root, "ios")) return;
      t = await api<TestflightStatus>(byHand ? "POST" : "GET", path);
      render();
      if (t.setUp && !wasSetUp) toast("TestFlight is set up");
      else if (t.stage === "open" && wasStage !== "open") toast("The invitation is open: friends can install");
      else if (byHand) toast(t.setUp ? "Checked with Apple" : t.needs === "store-app" ? "Not in App Store Connect yet" : "Up to date");
      schedule();
    } catch (err) {
      render();
      showError(root, err, "#testflight-result");
    } finally {
      busy = false;
      const still = box.querySelector<HTMLButtonElement>("#testflight-check");
      if (still?.disabled) {
        still.disabled = false;
        still.textContent = t.setUp ? "Check with Apple" : "Check now";
      }
    }
  };
  // Settings may have changed in another tab, or the app been added in App Store Connect.
  const refresh = async () => {
    try {
      const [next, fresh] = await Promise.all([api<TestflightStatus>("GET", path), whoAmI(true)]);
      t = next;
      if (fresh) me = fresh;
      render();
      schedule();
    } catch {
      // The next return to the page tries again.
    }
  };
  function onFocus(): void {
    if (!box!.isConnected) return stop();
    if (document.visibilityState !== "visible" || busy) return;
    if (t.setUp ? TF_WAITING.includes(t.stage ?? "no-build") : t.needs === "store-app") void check(false);
    else if (!t.setUp || t.stage !== "open") void refresh();
  }

  render();
  const statusButton = root.querySelector<HTMLButtonElement>('[data-target="ios"] [data-target-status]');
  if (statusButton) statusButton.onclick = () => void refresh();
  watchBuildStatus(box, path, next => {
    if (next.stage !== t.stage || next.needs !== t.needs || JSON.stringify(next.builds) !== JSON.stringify(t.builds)) {
      t = next;
      render();
    }
  });
  if (location.hash === "#testflight") box.scrollIntoView();
  addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  schedule();
}

export function platformDeliveryStatus(app: DevApp, platform: "macos" | "tvos", t: TestflightStatus): Raw {
  const name = platform === "macos" ? "Mac" : "Apple TV";
  const needs: Record<TestflightNeed, Raw> = {
    "bundle-id": html`Save the Apple bundle identifier under Build and publishing below. The default for this platform is the app's bundle identifier: <code>${app.bundleId}</code>.`,
    "apple-key": html`Save your App Store Connect key in <a href="/dev/settings#credentials">Settings</a>.`,
    signing: html`Set up Apple Distribution signing in <a href="/dev/settings#signing">Settings</a>.`,
    "review-contact": html`Save your beta review contact in <a href="/dev/settings#review-contact">Settings</a>.`,
    "store-app": html`Open <a href="${ASC_APPS}" target="_blank" rel="noopener">App Store Connect</a>. For an existing app record, add the ${platform === "macos" ? "macOS" : "tvOS"} platform to that record. For a new record, choose that platform and bundle identifier <code>${t.storeApp?.bundleId ?? app.bundleId}</code>. Then check again.`,
  };
  if (t.needs) return callout("info", needs[t.needs]);
  if (!t.stage) return html`<p class="small">Enable ${name} TestFlight when your app supports this platform.</p>`;
  const latest = t.builds[0];
  const version = latest ? `version ${latest.version} (build ${latest.buildNumber})` : "the build";
  const waiting = t.stage === "no-build" || t.stage === "waiting-for-upload";
  const messages: Record<TestflightStage, string> = {
    "no-build": `No ${name} build has been uploaded to ourapps.`,
    "waiting-for-upload": `No ${name} upload has arrived for this request. GitHub's matching platform run is shown below.`,
    processing: `Apple is processing the ${name} upload for ${version}.`,
    "in-review": `The ${name} upload for ${version} is with Apple's beta review${latest?.submittedAt ? `, submitted ${ago(latest.submittedAt)}` : ""}.`,
    approved: `Apple approved the ${name} build; its invitation is not open yet.`,
    "link-closed": `The ${name} build is available at Apple, but its public invitation is closed. Check the platform's testing group in App Store Connect.`,
    open: `The ${name} invitation is open.`,
    rejected: latest?.message || `Apple did not approve this ${name} build. Open App Store Connect for its review feedback.`,
    failed: latest?.message || `The ${name} upload failed. Check the matching workflow run for its error.`,
  };
  return html`<p>${pill(waiting ? `Awaiting ${name} upload` : STAGE_PILL[t.stage][0], waiting ? "accent" : STAGE_PILL[t.stage][1])}</p><p class="small muted">${messages[t.stage]}</p>`;
}

export function platformTestflightCard(app: DevApp, platform: "macos" | "tvos", t: TestflightStatus): Raw {
  const name = platform === "macos" ? "Mac" : "Apple TV";
  return html`<div class="card mt"><h2>${name} TestFlight</h2><p class="small muted">${platform === "macos" ? "Uses the selected Mac build type and its installer signing profile." : "Uses the Apple TV build and its testing group."}</p>
    <div data-platform-delivery>${platformDeliveryStatus(app, platform, t)}</div>
    ${t.buildRequest?.error ? callout("bad", html`<p>Build request failed: ${t.buildRequest.error}</p>`) : ""}
    ${platform === "macos" ? html`<div class="field mt-s"><label for="mac-build-type">Mac build type</label><select id="mac-build-type" data-mac-build-type><option value="catalyst" ${t.profileType !== "MAC_APP_STORE" ? "selected" : ""}>Mac Catalyst: iPhone/iPad app built for Mac</option><option value="native" ${t.profileType === "MAC_APP_STORE" ? "selected" : ""}>Native macOS app target</option></select><div class="hint">Choose the type built by the app's Xcode target. Both run as Mac applications; they need different distribution profiles.</div>${t.setUp ? html`<p class="small">Configured signing: <b>${t.profileType === "MAC_APP_STORE" ? "Native macOS" : "Mac Catalyst"}</b>.</p><button type="button" class="btn sm secondary" data-platform-type>Apply build type and set up profile</button>` : ""}</div>` : ""}
    <button type="button" class="btn sm" data-platform-setup>${t.setUp ? "Check with Apple" : `Set up ${name} TestFlight`}</button>
    ${t.setUp ? html`<button type="button" class="btn sm secondary" data-platform-build>Ask for ${name} build</button><button type="button" class="btn sm ghost" data-platform-repair>Set up again</button>` : ""}
    ${t.stage === "open" && t.invitation.state === "open" && t.url ? html`<p class="small"><a href="${t.url}">Open ${name} invitation</a></p>` : html`<p class="small muted">${name} invitation unavailable.</p>`}
    <div data-github-status>${buildStatusCard(t.buildStatus)}</div><div data-platform-builds>${buildTable(t)}</div><div data-platform-error></div></div>`;
}

async function loadPlatformTestflightCard(root: HTMLElement, app: DevApp, platform: "macos" | "tvos"): Promise<void> {
  const box = root.querySelector<HTMLElement>(`#${platform}-testflight-card`);
  if (!box) return;
  const path = `/api/dev/apps/${app.id}/testflight/${platform}`;
  const render = (t: TestflightStatus) => {
    const selectedType = box.querySelector<HTMLSelectElement>("[data-mac-build-type]")?.value;
    box.innerHTML = platformTestflightCard(app, platform, t).html;
    const typeChoice = box.querySelector<HTMLSelectElement>("[data-mac-build-type]");
    if (typeChoice && selectedType) typeChoice.value = selectedType;
    const act = async (button: HTMLButtonElement, suffix = "", repair = false) => {
      if (!targetEnabled(root, platform)) return;
      box.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = true);
      button.textContent = "Checking...";
      try {
        const type = box.querySelector<HTMLSelectElement>("[data-mac-build-type]");
        const body = suffix ? undefined : { ...(type && (!t.setUp || repair) ? { nativeMac: type.value === "native" } : {}), ...(repair ? { repair: true } : {}) };
        render(await api<TestflightStatus>("POST", path + suffix, body));
      } catch (err) {
        render(t);
        box.querySelector<HTMLElement>("[data-platform-error]")!.innerHTML = errorBox(err).html;
      }
    };
    const setup = box.querySelector<HTMLButtonElement>("[data-platform-setup]")!;
    setup.onclick = () => void act(setup);
    const build = box.querySelector<HTMLButtonElement>("[data-platform-build]");
    if (build) build.onclick = () => void act(build, "/build");
    const repair = box.querySelector<HTMLButtonElement>("[data-platform-repair]");
    if (repair) repair.onclick = () => void act(repair, "", true);
    const type = box.querySelector<HTMLButtonElement>("[data-platform-type]");
    if (type) type.onclick = () => void act(type, "", true);
  };
  try {
    render(await api<TestflightStatus>("GET", path));
    const statusButton = root.querySelector<HTMLButtonElement>(`[data-target="${platform}"] [data-target-status]`);
    if (statusButton) statusButton.onclick = async () => {
      try {
        const next = await api<TestflightStatus>("GET", path);
        const delivery = box.querySelector<HTMLElement>("[data-platform-delivery]");
        if (delivery) delivery.innerHTML = platformDeliveryStatus(app, platform, next).html;
        const builds = box.querySelector<HTMLElement>("[data-platform-builds]");
        if (builds) builds.innerHTML = buildTable(next).html;
      } catch (err) { showError(root, err, `#${platform}-testflight-card [data-platform-error]`); }
    };
    watchBuildStatus(box, path, next => {
      const delivery = box.querySelector<HTMLElement>("[data-platform-delivery]");
      if (delivery) delivery.innerHTML = platformDeliveryStatus(app, platform, next).html;
      const builds = box.querySelector<HTMLElement>("[data-platform-builds]");
      if (builds) builds.innerHTML = buildTable(next).html;
    });
  }
  catch (err) {
    box.innerHTML = errorBox(err).html;
    const retry = root.querySelector<HTMLButtonElement>(`[data-target="${platform}"] [data-target-status]`);
    if (retry) retry.onclick = () => void loadPlatformTestflightCard(root, app, platform);
  }
}

function releaseCardSkeleton(): Raw {
  return html`<div class="card"><div class="row"><div class="skeleton" style="width:120px;height:20px"></div><div class="grow"></div><div class="skeleton" style="width:80px;height:20px"></div></div><div class="skeleton mt" style="height:14px;width:60%"></div></div>`;
}

async function loadReleaseCard(root: HTMLElement, appId: string, app: DevApp): Promise<void> {
  const box = root.querySelector<HTMLElement>("#release-card");
  if (!box) return;
  try {
    release = await api<ReleaseStatus>("GET", `/api/dev/apps/${appId}/release`);
  } catch (err) {
    box.innerHTML = errorBox(err).html;
    root.querySelectorAll<HTMLElement>("[data-target-release]").forEach(summary => { summary.textContent = "Release information unavailable."; });
    return;
  }
  const r = release;
  for (const target of ["android", "web", "macos", "windows"] as const) {
    const summary = root.querySelector<HTMLElement>(`[data-target="${target}"] [data-target-release]`);
    if (summary) summary.innerHTML = retainedTargetRelease(r, target).html;
  }
  const platforms = r.install ? [r.install.ios ? "iPhone" : "", r.install.android ? "Android" : "", r.install.pwa ? "Web" : "", r.install.macos ? "Mac" : "", r.install.windows ? "Windows" : "", r.install.tvos ? "Apple TV" : ""].filter(Boolean).join(", ") : "";
  box.innerHTML = html`
    <div class="card">
      <div class="row wrap">
        <h2 class="grow">Latest release</h2>
        ${r.ok ? pill(`v${r.version}`, "ok", true) : pill("not readable", "bad", true)}
        <button class="btn sm secondary" id="recheck">${icon("refresh")} Check again</button>
      </div>
      ${r.ok
        ? html`
          <dl class="kv mt-s">
            <dt>Release</dt><dd>${r.tag ?? "direct URL"}${r.publishedAt ? html` <span class="faint">published ${fmtDate(r.publishedAt)}</span>` : ""}</dd>
            <dt>Platforms</dt><dd>${platforms || "none"}</dd>
            <dt>Assets</dt><dd>${r.assets.length > 0 ? r.assets.join(", ") : "n/a"}</dd>
            <dt>Screenshots in manifest</dt><dd>${r.screenshots}</dd>
            ${r.web ? html`<dt>Web app</dt><dd>${r.web.hosting === "own" ? html`<a href="${r.web.url!}" target="_blank" rel="noopener">${new URL(r.web.url!).host}</a> ${r.web.ok ? pill("answers", "ok") : pill(r.web.status ? `answers ${r.web.status}` : "no answer", "bad")}` : html`served by ourapps from web.zip`}</dd>` : ""}
            <dt>Release notes</dt><dd>${r.changelog ? "CHANGELOG.md shipped" : "no CHANGELOG.md in this release"}</dd>
          </dl>
          ${r.web?.hosting === "ourapps" ? callout("info", html`<p>The web version is served by ourapps from <code>web.zip</code>. Moving it to your own Cloudflare account makes it free without a request limit and leaves ourapps' shared allowance for installs. <a href="/dev/guide#cloudflare">How</a>.</p>`) : ""}
          ${r.web?.hosting === "own" && !r.web.ok ? callout("bad", html`<p>The web version's address <code>${r.web.url!}</code> did not answer${r.web.status ? html` (status ${r.web.status})` : ""}. Check the deploy step in the release workflow and that the Cloudflare secrets are set on the repository.</p>`) : ""}
          ${!r.changelog ? callout("warn", html`<p>No <code>CHANGELOG.md</code> in the latest release, so friends see release bodies or commit messages as the revision history. <a href="/dev/guide#release-notes">Add release notes</a>.</p>`) : ""}
          ${r.install?.ios && !r.appleKey ? callout("warn", html`<p>This app has an iPhone build but no App Store Connect key is saved. <a href="/dev/settings#credentials">Add it in Settings</a> so ourapps can put it on TestFlight.</p>`) : ""}
        `
        : html`
          ${callout("bad", html`<b>The console cannot read a release for ${app.repo}.</b>${r.errors.map((e) => html`<p>${e}</p>`)}`)}
          <div class="mt small muted">
            Fix in this order:
            <ol class="bullets">
              ${!r.githubToken ? html`<li>Save a GitHub token in <a href="/dev/settings#credentials">Settings</a> (private repositories are invisible without one).</li>` : html`<li>Check that the GitHub token saved in <a href="/dev/settings#credentials">Settings</a> includes ${app.repo}: on GitHub, edit the token and add the repository under Repository access. GitHub reports a repository it will not show the token as missing.</li>`}
              <li>Publish a GitHub Release (not a draft, not a pre-release) with an asset named <code>my-app.json</code>.</li>
              <li>Make sure my-app.json follows schema 1; the error above names the field when it does not.</li>
              <li>Let a coding agent do it: copy the prompt from <a href="/dev/agents">Agents and API</a>.</li>
            </ol>
          </div>
        `}
    </div>
  `.html;
  root.querySelector<HTMLButtonElement>("#recheck")!.onclick = () => {
    box.innerHTML = releaseCardSkeleton().html;
    void loadReleaseCard(root, appId, app);
  };
}
let release: ReleaseStatus | null = null;

function showToken(root: HTMLElement, appId: string, token: string): void {
  const box = root.querySelector<HTMLElement>("#token")!;
  box.innerHTML = html`
    <div class="card once mt">
      <h2>${icon("lock", "icon-20")} Build token, shown once</h2>
      <p>Copy it now; the console keeps only a hash. If you lose it, make a new one with "New build token".</p>
      <div class="field"><span class="label">STORE_BUILD_TOKEN</span>${copyRow(token)}</div>
      <div class="field"><span class="label">STORE_APP_ID</span>${copyRow(appId)}<div class="hint">The id of this app. The workflow uses it in ourapps' build addresses, and ourapps sends it as <code>app</code> when it asks the repository for a fresh build.</div></div>
      <p><b>Add both as Actions secrets on the app's GitHub repository.</b> Either route works:</p>
      <ol class="steps small">
        <li>On GitHub: open the repository, then <b>Settings</b>, <b>Secrets and variables</b>, <b>Actions</b>, <b>Repository secrets</b>, <b>New repository secret</b>. Create <code>STORE_BUILD_TOKEN</code> and <code>STORE_APP_ID</code>.</li>
        <li>In a terminal inside a checkout of the repository: ${copyRow(`gh secret set STORE_APP_ID --body "${appId}" && gh secret set STORE_BUILD_TOKEN`, "Copy command")}<div class="hint">The second command asks you to paste the token, so it never lands in your shell history. The token lets its holder fetch your iPhone signing key; keep it in repository secrets only.</div></li>
      </ol>
      <p class="small muted">Then make the repository follow the <a href="/contract.md">contract</a>, or hand that to an agent with the prompt on <a href="/dev/agents">Agents and API</a>.</p>
    </div>
  `.html;
  wireCopy(box);
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------------ */
/* Share links                                                         */
/* ------------------------------------------------------------------ */

export async function appLinks(root: HTMLElement, appId: string): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  let app: DevApp;
  let links: ShareLink[];
  try {
    ({ app, links } = await api<{ app: DevApp; links: ShareLink[] }>("GET", `/api/dev/apps/${appId}`));
  } catch (err) {
    return failed(root, me, err);
  }
  const now = Date.now();
  const state = (l: ShareLink) => (l.revokedAt ? "revoked" : l.expiresAt && Date.parse(l.expiresAt) < now ? "expired" : "active");
  const url = (l: ShareLink) => `${location.origin}/l/${l.id}`;

  mountShell(
    root,
    me,
    `Share links`,
    html`
      <div class="grid-2">
        <form id="link-form" class="card">
          <h2>New link</h2>
          <p class="small muted">Make one per person or group. A label tells you later who has it; rename it any time, and revoke one without affecting the others.</p>
          <div class="field"><label>Label</label><input type="text" name="label" maxlength="80" placeholder="Mum and Dad" /></div>
          <div class="field"><label>Expires <span class="faint tiny">optional</span></label><input type="datetime-local" name="expiresAt" /><div class="hint">After this moment the link shows "no longer active". Friends who already installed keep the app.</div></div>
          <div id="error"></div>
          <button class="btn" type="submit">${icon("plus")} Create link</button>
        </form>
        <div class="card">
          <h2>How to send it</h2>
          <ol class="steps small">
            <li><b>Messages or WhatsApp:</b> tap Share on a link below and pick the person. On iPhone the link opens in Safari's own view, where installs work.</li>
            <li><b>In person:</b> show the QR code; the camera app opens it.</li>
            <li><b>Email:</b> paste the link. Gmail's built-in browser cannot install, but the page tells the friend to open it in Safari or Chrome.</li>
          </ol>
          <p class="small muted">Instagram, Facebook and TikTok messages open pages inside their own browsers, which cannot install apps. The page explains the one extra tap.</p>
        </div>
      </div>
      <div class="section-title"><h2>${links.length === 0 ? "No links yet" : `${links.length} link${links.length === 1 ? "" : "s"}`}</h2></div>
      <div class="stack">
        ${links.map((l) => {
          const s = state(l);
          return html`
            <div class="link-card" data-link="${l.id}">
              <div>
                <div class="row wrap" data-title="${l.id}"><b style="font-size:16px">${l.label || "Untitled link"}</b>${statePill(s)}<button class="btn sm ghost" data-rename="${l.id}" data-label="${l.label}" title="Rename this link">${icon("edit")} Rename</button></div>
                <div class="small muted" style="margin:4px 0 10px">Created ${fmtDate(l.createdAt)}${l.expiresAt ? `, expires ${fmtDate(l.expiresAt, true)}` : ""}${l.revokedAt ? `, revoked ${fmtDate(l.revokedAt, true)}` : ""}</div>
                ${copyRow(url(l))}
                <div class="row wrap mt-s">
                  ${s === "active" ? html`<button class="btn sm" data-share="${l.id}">${icon("share")} Share</button><a class="btn sm secondary" href="${url(l)}" target="_blank" rel="noopener">${icon("eye")} Open</a><a class="btn sm secondary" href="/api/public/links/${l.id}/qr.svg" download="${(app.name || "app").replace(/\s+/g, "-")}-qr.svg">${icon("qr")} QR file</a><button class="btn sm ghost" data-revoke="${l.id}">Revoke</button>` : ""}
                  <button class="btn sm danger" data-delete="${l.id}">${icon("trash")} Delete</button>
                </div>
              </div>
              ${s === "active" ? html`<div class="qr">${qrSvg(url(l))}</div>` : ""}
            </div>`;
        })}
      </div>
    `,
    { crumbs: html`<a href="/dev/apps">Apps</a> / <a href="/dev/apps/${appId}">${app.name}</a> / Share links`, sub: `${app.name}. Links open the install page at /l/<id>; the id is random and never lists anywhere.` },
  );

  const form = root.querySelector<HTMLFormElement>("#link-form")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const expires = String(fd.get("expiresAt") ?? "");
    try {
      await api("POST", `/api/dev/apps/${appId}/links`, { label: String(fd.get("label") ?? ""), expiresAt: expires ? new Date(expires).toISOString() : null });
      toast("Link created");
      await appLinks(root, appId);
    } catch (err) {
      showError(root, err);
    }
  };
  root.querySelectorAll<HTMLButtonElement>("[data-share]").forEach((b) => (b.onclick = async () => {
    const result = await shareOrCopy(`${location.origin}/l/${b.dataset.share}`, app.name);
    if (result === "copied") toast("Link copied");
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-rename]").forEach((b) => (b.onclick = () => startRename(root, appId, b.dataset.rename!, b.dataset.label ?? "")));
  root.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmAction("Revoke this link? Anyone opening it sees \"no longer active\"."))) return;
    await api("POST", `/api/dev/links/${b.dataset.revoke}/revoke`);
    await appLinks(root, appId);
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmAction("Delete this link for good?"))) return;
    await api("DELETE", `/api/dev/links/${b.dataset.delete}`);
    await appLinks(root, appId);
  }));
}

// Swaps a link's title for a small form; Enter saves, Escape cancels. The link's address never changes.
function startRename(root: HTMLElement, appId: string, linkId: string, current: string): void {
  const title = root.querySelector<HTMLElement>(`[data-title="${linkId}"]`);
  if (!title) return;
  const original = title.innerHTML;
  title.innerHTML = html`<form class="row wrap" data-rename-form style="flex:1"><input type="text" name="label" value="${current}" maxlength="80" placeholder="Who has this link" aria-label="Link label" style="flex:1;min-width:180px" /><button class="btn sm" type="submit">Save</button><button class="btn sm secondary" type="button" data-cancel>Cancel</button></form>`.html;
  const form = title.querySelector<HTMLFormElement>("[data-rename-form]")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const cancel = () => {
    title.innerHTML = original;
    title.querySelector<HTMLButtonElement>("[data-rename]")!.onclick = () => startRename(root, appId, linkId, current);
  };
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  });
  form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = cancel;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("PUT", `/api/dev/links/${linkId}`, { label: input.value });
      toast("Renamed");
      await appLinks(root, appId);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function savedMarker(present: boolean, savedAt: string | null, group: string): Raw {
  if (!present) return pill("not saved", "warn");
  return html`${pill(`saved${savedAt ? " " + fmtDate(savedAt, true) : ""}`, "ok", true)} <button type="button" class="btn sm ghost" data-remove-secret="${group}">Remove</button>`;
}

const SECRET_GROUPS: Record<string, string[]> = {
  apple: ["appleIssuerId", "appleKeyId", "applePrivateKey"],
  appleTeamId: ["appleTeamId"],
  githubToken: ["githubToken"],
};

const EVENT_LABELS: Record<string, string> = {
  "sign-in": "Signed in",
  "sign-out": "Signed out",
  "sign-out-everywhere": "Signed out everywhere",
  "credentials-saved": "Credentials saved",
  "credentials-removed": "Credentials removed",
  "api-key-created": "API key created",
  "api-key-revoked": "API key revoked",
  "api-keys-revoked-all": "All API keys revoked",
  "build-token-rotated": "Build token rotated",
  "encryption-declared": "Export compliance answer set",
  "terms-accepted": "Terms accepted",
  "app-created": "App created",
  "app-deleted": "App deleted",
  "signing-set-up": "iPhone signing set up",
};

// Makes the key and request in this browser, then lets the server get the certificate.
async function runSigningSetUp(): Promise<SigningSetUp> {
  const { csr, privateKey } = await signingRequest("ourapps");
  return api<SigningSetUp>("POST", "/api/dev/signing", { csr, privateKey });
}

function signingOutcome(outcome: { result?: SigningSetUp; error?: string }): Raw {
  if (outcome.error) return callout("bad", html`<p><b>iPhone signing was not set up.</b> ${outcome.error}</p>`);
  const r = outcome.result!;
  return callout(
    "ok",
    html`<p><b>Certificate created: ${r.signing.name}.</b></p>
      ${r.apps.length > 0 ? html`<ul class="bullets small">${r.apps.map((a) => html`<li><b>${a.name}</b>: ${a.error ?? "App Store profile made again with the new certificate"}</li>`)}</ul>` : ""}`,
  );
}

export async function settings(root: HTMLElement, note = "", signingNote?: { result?: SigningSetUp; error?: string }): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  const { events } = await api<{ events: AuditEvent[] }>("GET", "/api/dev/audit").catch(() => ({ events: [] as AuditEvent[] }));
  mountShell(
    root,
    me,
    "Settings",
    html`
      <div class="grid-2">
        <form id="me-form" class="card">
          <h2>Profile</h2>
          <div class="field"><label>Display name</label><input type="text" name="displayName" value="${me.developer.displayName}" required maxlength="80" /><div class="hint">Shown to friends on every install page.</div></div>
          <div class="field"><label>Public page address</label><input type="text" name="slug" value="${me.developer.slug}" required maxlength="40" /><div class="hint">${location.origin}/${me.developer.slug}</div></div>
          <div id="error"></div>
          <button class="btn" type="submit">Save profile</button>
        </form>
        <div class="card">
          <h2>Account</h2>
          <dl class="kv">
            <dt>GitHub</dt><dd>@${me.developer.githubLogin}</dd>
            <dt>Member since</dt><dd>${fmtDate(me.developer.createdAt)}</dd>
            <dt>Public page</dt><dd><a href="/${me.developer.slug}">/${me.developer.slug}</a></dd>
            <dt>Terms</dt><dd>${me.developer.termsAcceptedVersion ? html`Version ${me.developer.termsAcceptedVersion}, accepted ${fmtDate(me.developer.termsAcceptedAt, true)}` : "not accepted"} · <a href="/terms">Read the terms and data statement</a></dd>
          </dl>
          <p class="small muted mt">Sign-in only reads your public GitHub profile. Repository access comes from the token you save below, which you control and can revoke on GitHub at any time.</p>
          <hr />
          <h3>Delete account</h3>
          <p class="small muted">Removes your profile, credentials, API keys, apps, share links and signing key at once. The certificate, the App Store profiles and the apps in App Store Connect stay on your Apple account until you remove them there; TestFlight builds keep working until they expire.</p>
          <div class="row wrap"><input type="text" id="confirm-login" placeholder="Type ${me.developer.githubLogin} to confirm" style="flex:1;min-width:200px" /><button class="btn danger" id="delete-account" disabled>${icon("trash")} Delete my account</button></div>
          <div id="delete-error" class="mt-s"></div>
        </div>
      </div>

      <form id="secrets-form" class="card mt" >
        <a id="credentials"></a>
        <h2>Credentials</h2>
        <p class="small muted">Stored encrypted with a key derived for your account and never shown again. Leave a field blank to keep what is saved.</p>
        ${note ? callout("ok", html`<p>${note}</p>`) : ""}

        <div class="form-section">
          <div class="about"><h3>GitHub token</h3><p>Lets the console read release assets from private repositories and ask them for fresh builds. <a href="/dev/guide#github-token">How to create one</a>.</p></div>
          <div>
            <div class="row wrap mb">${savedMarker(me.secrets.github, me.secrets.githubSavedAt, "githubToken")}</div>
            <div class="field"><label>Fine-grained token</label><input type="text" name="githubToken" autocomplete="off" placeholder="${me.secrets.github ? "saved; paste a new one to replace" : "github_pat_..."}" /><div class="hint">Permissions on the app repositories: Contents read and write for releases and iPhone/iPad build requests; Actions read for status, or Actions read and write to request Mac/Apple TV workflows.</div></div>
          </div>
        </div>

        <div class="form-section">
          <div class="about"><h3>App Store Connect API key</h3><p>Lets ourapps make the signing certificate, put iPhone apps on TestFlight and send each build to friends. Needs the Admin role. <a href="/dev/guide#apple-key">How to create one</a>.</p></div>
          <div>
            <div class="row wrap mb">${savedMarker(me.secrets.apple, me.secrets.appleSavedAt, "apple")}</div>
            <div class="field"><label>Issuer ID</label><input type="text" name="appleIssuerId" autocomplete="off" placeholder="${me.secrets.apple ? "saved" : "57246542-96fe-1a63-e053-0824d011072a"}" /></div>
            <div class="field"><label>Key ID</label><input type="text" name="appleKeyId" autocomplete="off" placeholder="${me.secrets.apple ? "saved" : "2X9R4HXF34"}" /></div>
            <div class="field"><label>Private key (.p8 contents)</label><textarea name="applePrivateKey" autocomplete="off" placeholder="${me.secrets.apple ? "saved" : "-----BEGIN PRIVATE KEY-----"}"></textarea></div>
          </div>
        </div>

        <div class="form-section">
          <div class="about"><h3>Apple team ID</h3><p>Ten characters, shown under Membership details on developer.apple.com.</p></div>
          <div>
            <div class="row wrap mb">${savedMarker(Boolean(me.secrets.appleTeamId), me.secrets.appleTeamIdSavedAt, "appleTeamId")}</div>
            <div class="field"><input type="text" name="appleTeamId" value="${me.secrets.appleTeamId}" autocomplete="off" placeholder="ABCDE12345" /></div>
          </div>
        </div>
        <div id="secrets-error"></div>
        <div class="form-actions"><button class="btn" type="submit">Save credentials</button></div>
      </form>

      <div class="card mt">
        <a id="signing"></a>
        <div class="row wrap"><h2 class="grow">iPhone signing</h2>${me.secrets.signing ? pill("set up", "ok", true) : me.secrets.apple ? pill("not set up", "warn") : ""}</div>
        <p class="small muted">ourapps creates an Apple Distribution certificate on your Apple account, keeps its private key encrypted like the credentials above, makes each app's App Store profile when the app goes on TestFlight, and gives certificate, key and profile to an app's release workflow when it presents that app's build token. Your repositories need no Apple secrets. The key is made in this browser.</p>
        ${me.secrets.signing
          ? html`<dl class="kv mt-s"><dt>Certificate</dt><dd>${me.secrets.signing.name}</dd><dt>Expires</dt><dd>${fmtDate(me.secrets.signing.expirationDate)}</dd><dt>Created</dt><dd>${fmtDate(me.secrets.signing.createdAt, true)}</dd></dl>`
          : !me.secrets.apple
            ? html`<p class="small">Save the App Store Connect key above; setup then runs by itself.</p>`
            : ""}
        <div id="signing-box">${signingNote ? signingOutcome(signingNote) : ""}</div>
        ${me.secrets.apple ? html`<div class="form-actions"><button class="btn ${me.secrets.signing ? "secondary" : ""}" type="button" id="signing-run">${me.secrets.signing ? "Replace certificate" : "Set up iPhone signing"}</button></div>` : ""}
      </div>

      <form id="review-form" class="card mt">
        <a id="review-contact"></a>
        <div class="row wrap"><h2 class="grow">TestFlight review contact</h2>${me.reviewContact ? pill("saved", "ok", true) : pill("not saved", "warn")}</div>
        <p class="small muted">Apple reviews the first build of each version before friends can install it through TestFlight, and asks for someone to contact. ourapps sends these details to Apple for each app you put on TestFlight.</p>
        <div class="row wrap">
          <div class="field grow"><label>First name</label><input type="text" name="firstName" value="${me.reviewContact?.firstName ?? ""}" maxlength="60" required /></div>
          <div class="field grow"><label>Last name</label><input type="text" name="lastName" value="${me.reviewContact?.lastName ?? ""}" maxlength="60" required /></div>
        </div>
        <div class="row wrap">
          <div class="field grow"><label>Email</label><input type="email" name="email" value="${me.reviewContact?.email ?? ""}" maxlength="120" required /></div>
          <div class="field grow"><label>Phone, with country code</label><input type="tel" name="phone" value="${me.reviewContact?.phone ?? ""}" maxlength="40" placeholder="+44 7700 900123" required /></div>
        </div>
        <div id="review-error"></div>
        <div class="form-actions"><button class="btn" type="submit">Save contact</button></div>
      </form>

      <div class="card mt">
        <a id="security"></a>
        <div class="row wrap"><h2 class="grow">Security</h2><button class="btn sm danger" id="logout-all">Sign out everywhere</button></div>
        <p class="small muted">How your credentials are kept: each field is encrypted on its own with AES-256-GCM under a key derived for your account alone; the master secret lives only in the server's secret store, never in the database or in code. API keys, build tokens and sessions are stored as keyed hashes, so a copy of the database cannot be used to sign in. Credentials can only be changed from this page in a browser session, never with an API key.</p>
        <h3 class="mt">Recent activity</h3>
        ${events.length === 0 ? html`<p class="small muted">Nothing recorded yet.</p>` : html`<table class="table small mt-s">${events.slice(0, 25).map((e) => html`<tr><td style="white-space:nowrap">${fmtDate(e.createdAt, true)}</td><td><b>${EVENT_LABELS[e.event] ?? e.event}</b>${e.detail ? html` <span class="muted">${e.detail}</span>` : ""}</td><td class="faint">${e.country ?? ""}</td></tr>`)}</table>`}
        <p class="tiny faint mt-s">Anything here you do not recognise: sign out everywhere, revoke your API keys on the Agents page, and replace the GitHub token and Apple key at their sources.</p>
      </div>
    `,
    { sub: "Who you are to your friends, and the keys the console uses on your behalf." },
  );
  const confirmInput = root.querySelector<HTMLInputElement>("#confirm-login")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>("#delete-account")!;
  confirmInput.oninput = () => (deleteBtn.disabled = confirmInput.value.trim() !== me.developer.githubLogin);
  deleteBtn.onclick = async () => {
    if (!(await confirmAction("Delete your account and everything in it? This cannot be undone."))) return;
    try {
      await api("DELETE", "/api/dev/me", { confirm: confirmInput.value.trim() });
      location.href = "/";
    } catch (err) {
      showError(root, err, "#delete-error");
    }
  };
  root.querySelector<HTMLButtonElement>("#logout-all")!.onclick = async () => {
    if (!(await confirmAction("Sign out of every browser, including this one? API keys stay valid; revoke them on the Agents page if needed."))) return;
    await api("POST", "/api/auth/logout-everywhere");
    location.href = "/";
  };
  if (signingNote) root.querySelector("#signing")?.scrollIntoView();
  else if (["#credentials", "#security", "#signing", "#review-contact"].includes(location.hash)) root.querySelector(location.hash)?.scrollIntoView();
  const reviewForm = root.querySelector<HTMLFormElement>("#review-form")!;
  reviewForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(reviewForm);
    try {
      await api("PUT", "/api/dev/review-contact", { firstName: fd.get("firstName"), lastName: fd.get("lastName"), email: fd.get("email"), phone: fd.get("phone") });
      toast("Review contact saved");
      await settings(root);
    } catch (err) {
      showError(root, err, "#review-error");
    }
  };

  const meForm = root.querySelector<HTMLFormElement>("#me-form")!;
  meForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(meForm);
    try {
      await api("PUT", "/api/dev/me", { displayName: fd.get("displayName"), slug: fd.get("slug") });
      toast("Profile saved");
      await settings(root);
    } catch (err) {
      showError(root, err);
    }
  };
  const secretsForm = root.querySelector<HTMLFormElement>("#secrets-form")!;
  secretsForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(secretsForm);
    const body: Record<string, unknown> = {};
    for (const k of ["appleIssuerId", "appleKeyId", "applePrivateKey", "appleTeamId", "githubToken"]) body[k] = fd.get(k);
    const changed = Object.values(body).filter((v) => String(v ?? "").trim() !== "").length;
    const appleChanged = ["appleIssuerId", "appleKeyId", "applePrivateKey"].some((k) => String(body[k] ?? "").trim() !== "");
    let saved: { secrets: SecretStatus };
    try {
      saved = await api<{ secrets: SecretStatus }>("PUT", "/api/dev/secrets", body);
    } catch (err) {
      showError(root, err, "#secrets-error");
      return;
    }
    const note = changed > 0 ? "Credentials saved." : "Nothing to save; all fields were blank.";
    if (!appleChanged || !saved.secrets.apple || saved.secrets.signing) return settings(root, note);
    root.querySelector<HTMLElement>("#signing-box")!.innerHTML = callout("info", html`<p>Credentials saved. Setting up iPhone signing...</p>`).html;
    try {
      await settings(root, note, { result: await runSigningSetUp() });
    } catch (err) {
      await settings(root, note, { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const signingButton = root.querySelector<HTMLButtonElement>("#signing-run");
  if (signingButton) {
    signingButton.onclick = async () => {
      if (me.secrets.signing && !(await confirmAction("Create a new certificate and make the App Store profile of every app on TestFlight again with it? The current certificate stays valid on Apple until it expires or you revoke it in the developer portal."))) return;
      signingButton.disabled = true;
      root.querySelector<HTMLElement>("#signing-box")!.innerHTML = callout("info", html`<p>Making a key in this browser and asking Apple for the certificate...</p>`).html;
      try {
        await settings(root, "", { result: await runSigningSetUp() });
      } catch (err) {
        await settings(root, "", { error: err instanceof Error ? err.message : String(err) });
      }
    };
  }
  root.querySelectorAll<HTMLButtonElement>("[data-remove-secret]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmAction("Remove this credential? Anything that needs it, such as TestFlight uploads or reading private releases, stops working."))) return;
    const body: Record<string, string> = {};
    for (const k of SECRET_GROUPS[b.dataset.removeSecret!]) body[k] = "-";
    await api("PUT", "/api/dev/secrets", body);
    await settings(root, "Credential removed.");
  }));
}

/* ------------------------------------------------------------------ */
/* Agents and API                                                      */
/* ------------------------------------------------------------------ */

export async function agents(root: HTMLElement): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  let keys: ApiKey[] = [];
  let apps: DevApp[] = [];
  try {
    [{ keys }, { apps }] = await Promise.all([api<{ keys: ApiKey[] }>("GET", "/api/dev/keys"), api<{ apps: DevApp[] }>("GET", "/api/dev/apps")]);
  } catch (err) {
    return failed(root, me, err);
  }
  const repoPromptFor = (a: DevApp | undefined) => AGENT_REPO_PROMPT({ repo: a?.repo || "<owner>/<name>", appId: a?.id || "<STORE_APP_ID>", bundleId: a?.bundleId || "<bundle id>", name: a?.name || "<app name>" });
  const filledFor = (a: DevApp | undefined) => (a ? `(filled in for ${a.name})` : "(placeholders for a new app)");
  const first = apps[0];
  const repoPrompt = repoPromptFor(first);
  const storePrompt = AGENT_STORE_PROMPT();

  mountShell(
    root,
    me,
    "Agents and API",
    html`
      ${callout("info", html`<p><b>Everything the console does is an API, and the prompts below explain it all to an agent.</b> What stays with you: signing in, creating the GitHub token, the Apple key and, for web apps, the Cloudflare token, creating an API key here, adding each iPhone app once in App Store Connect, and sending links to people. The <a href="/dev/guide#tldr">TL;DR in the guide</a> lists exactly those. Full reference: <a href="/agents.md">ourapps.app/agents.md</a>; repository contract: <a href="/contract.md">ourapps.app/contract.md</a>.</p>`)}

      <div class="grid-2 mt">
        <div class="card">
          <h2>API keys</h2>
          <p class="small muted">A key acts as you within its scope. It can never create or revoke keys or change credentials. Make one per agent or machine so you can revoke them one at a time.</p>
          <form id="key-form" class="mt">
            <div class="field"><label>Name</label><input type="text" name="name" placeholder="laptop agent" maxlength="60" /></div>
            <div class="row wrap">
              <div class="field grow"><label>Scope</label><select name="scope"><option value="manage">Manage: create apps and links, set up TestFlight</option><option value="read">Read only: list and check</option></select></div>
              <div class="field grow"><label>Expires</label><select name="expiresInDays"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="">Never</option></select></div>
            </div>
            <button class="btn" type="submit">${icon("plus")} Create key</button>
          </form>
          <div id="error"></div>
          <div id="new-key"></div>
          <div class="mt" id="key-list">${keyList(keys)}</div>
          ${keys.length > 1 ? html`<button class="btn sm ghost mt" id="revoke-all">Revoke all keys</button>` : ""}
        </div>
        <div class="card">
          <h2>Quick reference</h2>
          <p class="small muted">Base URL <code>${location.origin}</code>. Header <code>Authorization: Bearer oa_...</code>. JSON in, JSON out, errors as <code>{"error": "..."}</code>.</p>
          <table class="table small mt-s">
            <tr><td><code>GET /api/dev/me</code></td><td>who the key belongs to</td></tr>
            <tr><td><code>GET, POST /api/dev/apps</code></td><td>list, create (returns the build token once)</td></tr>
            <tr><td><code>GET, PUT, DELETE /api/dev/apps/:id</code></td><td>read with links, update, delete</td></tr>
            <tr><td><code>PUT /api/dev/apps/:id/targets/:target</code></td><td>save exactly <code>{enabled:boolean}</code>; returns <code>{targets:AppTargets}</code>; app owner's browser session or manage key</td></tr>
            <tr><td><code>GET /api/dev/apps/:id/release</code></td><td>what the latest release looks like and why it fails</td></tr>
            <tr><td><code>POST /api/dev/apps/:id/links</code></td><td>new share link</td></tr>
            <tr><td><code>GET /api/public/links/:id/qr.svg</code></td><td>QR for a link</td></tr>
            <tr><td><code>GET, POST /api/dev/apps/:id/testflight</code></td><td>where TestFlight stands and the next step; set it up</td></tr>
            <tr><td><code>GET, POST /api/dev/apps/:id/testflight/:platform</code></td><td>separate Mac or Apple TV setup/status; Mac setup requires a browser session</td></tr>
            <tr><td><code>GET /api/build/:app/targets</code></td><td>read <code>{targets:AppTargets}</code> using that app's build token as the bearer credential</td></tr>
          </table>
          <p class="small muted"><code>AppTargets</code> contains six booleans: <code>ios</code>, <code>android</code>, <code>web</code>, <code>macos</code>, <code>windows</code> and <code>tvos</code>.</p>
          <pre class="mt-s"><code>curl -H "Authorization: Bearer $OURAPPS_API_KEY" \\
  ${location.origin}/api/dev/apps</code></pre>
          <p class="small muted mt-s">Source code and issues: <a href="${SOURCE_URL}" target="_blank" rel="noopener">github.com/george-mcintyre/ourapps</a>.</p>
        </div>
      </div>

      <div class="section-title"><h2>Prompts for your agents</h2></div>
      ${apps.length > 0
        ? html`<div class="field prompt-app"><label for="prompt-app">Project</label><select id="prompt-app">${apps.map((a) => html`<option value="${a.id}">${a.name}</option>`)}<option value="">A new app (placeholders)</option></select></div>`
        : ""}
      <p class="muted small">Copy, fill in the angle brackets if any remain, and paste into your coding agent. The first one works inside the app repository; the second one drives this console through the API.</p>
      <div class="card">
        <h3>1. Set up the app repository <span class="faint small" id="prompt-for">${filledFor(first)}</span></h3>
        <p class="small muted">Give this to an agent running inside the repository (Claude Code, Codex, Cursor, opencode). It creates the release workflow and my-app.json the contract asks for.</p>
        <div class="prompt-box" id="repo-prompt"><button class="btn sm secondary" data-copy="${repoPrompt}">${icon("copy")} Copy</button><pre>${repoPrompt}</pre></div>
      </div>
      <div class="card">
        <h3>2. Manage the console through the API</h3>
        <p class="small muted">Give this to an agent that has your API key in the environment variable <code>OURAPPS_API_KEY</code>. It can register apps, check releases, set up TestFlight and hand you share links.</p>
        <div class="prompt-box"><button class="btn sm secondary" data-copy="${storePrompt}">${icon("copy")} Copy</button><pre>${storePrompt}</pre></div>
      </div>
    `,
    { sub: "Let a coding agent do the repository work and drive this console for you." },
  );

  // The repository prompt follows the chosen project; Copy reads the attribute when clicked.
  root.querySelector<HTMLSelectElement>("#prompt-app")?.addEventListener("change", (e) => {
    const chosen = apps.find((a) => a.id === (e.target as HTMLSelectElement).value);
    const text = repoPromptFor(chosen);
    const box = root.querySelector<HTMLElement>("#repo-prompt")!;
    box.querySelector("pre")!.textContent = text;
    box.querySelector<HTMLButtonElement>("[data-copy]")!.dataset.copy = text;
    root.querySelector("#prompt-for")!.textContent = filledFor(chosen);
  });

  const form = root.querySelector<HTMLFormElement>("#key-form")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const days = String(fd.get("expiresInDays") ?? "");
    try {
      const res = await api<{ key: string; apiKey: ApiKey }>("POST", "/api/dev/keys", { name: fd.get("name"), scope: fd.get("scope"), expiresInDays: days === "" ? null : Number(days) });
      const box = root.querySelector<HTMLElement>("#new-key")!;
      box.innerHTML = html`<div class="once mt"><b>${icon("lock", "icon-16")} Key for "${res.apiKey.name}", shown once</b>${copyRow(res.key)}<p class="small mt-s">Store it where the agent runs, for example <code>export OURAPPS_API_KEY=${res.key}</code>. It cannot be shown again.</p></div>`.html;
      wireCopy(box);
      form.reset();
      await refreshKeys(root);
    } catch (err) {
      showError(root, err);
    }
  };
  wireKeyButtons(root);
  root.querySelector<HTMLButtonElement>("#revoke-all")?.addEventListener("click", async () => {
    if (!(await confirmAction("Revoke every API key? Every agent using one stops working at once."))) return;
    await api("POST", "/api/dev/keys/revoke-all");
    toast("All keys revoked");
    await agents(root);
  });
}

function keyList(keys: ApiKey[]): Raw {
  if (keys.length === 0) return html`<p class="small muted">No keys yet.</p>`;
  return html`${keys.map((k) => html`
    <div class="key-row">
      <div>
        <b>${k.name}</b> <code>${k.prefix}...</code> ${pill(k.scope === "read" ? "read only" : "manage", k.scope === "read" ? "" : "accent")}
        <div class="tiny faint">Created ${fmtDate(k.createdAt)}${k.expiresAt ? `, expires ${fmtDate(k.expiresAt)}` : ", no expiry"}${k.lastUsedAt ? `, last used ${fmtDate(k.lastUsedAt, true)}` : ", never used"}</div>
      </div>
      <button class="btn sm danger" data-revoke-key="${k.id}">Revoke</button>
    </div>`)}`;
}

function wireKeyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-revoke-key]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmAction("Revoke this key? Anything using it stops working at once."))) return;
    await api("DELETE", `/api/dev/keys/${b.dataset.revokeKey}`);
    toast("Key revoked");
    await agents(root);
  }));
}

async function refreshKeys(root: HTMLElement): Promise<void> {
  const { keys } = await api<{ keys: ApiKey[] }>("GET", "/api/dev/keys");
  const rows = root.querySelector<HTMLElement>("#key-list");
  if (!rows) return;
  rows.innerHTML = keyList(keys).html;
  wireKeyButtons(root);
}

export { raw, wireImages, copyText, ApiError };
