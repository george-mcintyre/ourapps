import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handle } from "../src/index.js";
import { advanceBuild, tickTestflight } from "../src/testflight.js";
import { AppleClient } from "../src/apple.js";
import type { AppRow, TestflightBuildRow } from "../src/db.js";
import { BASE, CSR, api, applePem, appleRoutes, clearDb, fakeFetch, githubRoutes, jsonRes, manifest, rsaPem, saveAppleSecrets, signIn, testDeps, testEnv, type Call, type TestDeps } from "./helpers.js";

const apple = (p: string) => `api.appstoreconnect.apple.com${p}`;

let env: Env;
let deps: TestDeps;
let cookie: string;

beforeEach(async () => {
  env = testEnv();
  await clearDb(env);
  deps = testDeps(fakeFetch(githubRoutes()).fetch);
  cookie = await signIn(env, deps);
});

// Apple as TestFlight sees it: one App Store Connect app, groups, review details, uploads and builds.
type Store = {
  storeApp: boolean;
  build?: { processingState: string; usesNonExemptEncryption: boolean | null };
  // Apple's external beta state of the build, and what the public invitation page says.
  beta?: string;
  autoNotify?: boolean;
  invitation?: "closed" | "open" | "full";
  // Beta localizations at Apple; the app's primary language is en-GB.
  locales?: string[];
};

const JOIN_CLOSED = `<title>TestFlight - Apple</title><div class="beta-status"><span>This beta isn&#39;t accepting any new testers right now.</span></div>`;
const JOIN_OPEN = `<title>Join the Skull beta - TestFlight - Apple</title><div id="steps">Step 1 Get TestFlight</div>`;
const JOIN_FULL = `<title>Join the Skull beta - TestFlight - Apple</title><div class="beta-status">This beta is full.</div>`;

function storeRoutes(state: Store) {
  const groups: { id: string; name: string; publicLink: string | null }[] = [];
  return {
    ...appleRoutes({ noOldProfile: true, bundleIds: [{ id: "bid-skull", identifier: "com.example.skull" }] }),
    [`GET ${apple("/v1/apps")}`]: () => jsonRes({ data: state.storeApp ? [{ id: "asc-1", type: "apps", attributes: { bundleId: "com.example.skull", name: "Skull" } }] : [] }),
    [`GET ${apple("/v1/apps/asc-1/betaGroups")}`]: () => jsonRes({ data: groups.map((g) => ({ id: g.id, type: "betaGroups", attributes: { name: g.name, isInternalGroup: false, publicLinkEnabled: true, publicLink: g.publicLink } })) }),
    [`POST ${apple("/v1/betaGroups")}`]: (c: Call) => {
      const g = { id: "grp-1", name: JSON.parse(c.body!).data.attributes.name, publicLink: "https://testflight.apple.com/join/AbCd1234" };
      groups.push(g);
      return jsonRes({ data: { id: g.id, type: "betaGroups", attributes: { name: g.name, isInternalGroup: false, publicLinkEnabled: true, publicLink: g.publicLink } } }, 201);
    },
    [`GET ${apple("/v1/apps/asc-1/betaAppReviewDetail")}`]: () => jsonRes({ data: { id: "rev-1", type: "betaAppReviewDetails", attributes: {} } }),
    [`PATCH ${apple("/v1/betaAppReviewDetails/rev-1")}`]: () => jsonRes({ data: { id: "rev-1", type: "betaAppReviewDetails", attributes: {} } }),
    [`GET ${apple("/v1/apps/asc-1")}`]: () => jsonRes({ data: { id: "asc-1", type: "apps", attributes: { primaryLocale: "en-GB" } } }),
    [`GET ${apple("/v1/apps/asc-1/betaAppLocalizations")}`]: () => jsonRes({ data: (state.locales ?? []).map((l) => ({ id: `loc-${l}`, type: "betaAppLocalizations", attributes: { locale: l, feedbackEmail: "g@example.com" } })) }),
    [`POST ${apple("/v1/betaAppLocalizations")}`]: (c: Call) => {
      const locale = JSON.parse(c.body!).data.attributes.locale as string;
      state.locales = [...(state.locales ?? []), locale];
      return jsonRes({ data: { id: `loc-${locale}`, type: "betaAppLocalizations", attributes: {} } }, 201);
    },
    [`PATCH ${apple("/v1/betaAppLocalizations/loc-en-US")}`]: () => jsonRes({ data: { id: "loc-en-US", type: "betaAppLocalizations", attributes: {} } }),
    [`PATCH ${apple("/v1/betaAppLocalizations/loc-en-GB")}`]: () => jsonRes({ data: { id: "loc-en-GB", type: "betaAppLocalizations", attributes: {} } }),
    [`POST ${apple("/v1/buildUploads")}`]: () => jsonRes({ data: { id: "up-1", type: "buildUploads", attributes: {} } }, 201),
    [`POST ${apple("/v1/buildUploadFiles")}`]: () =>
      jsonRes({ data: { id: "file-1", type: "buildUploadFiles", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example/part1", offset: 0, length: 9, requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] }] } } }, 201),
    [`PATCH ${apple("/v1/buildUploadFiles/file-1")}`]: () => jsonRes({ data: { id: "file-1", type: "buildUploadFiles", attributes: {} } }),
    [`GET ${apple("/v1/buildUploads/up-1")}`]: () => jsonRes({ data: { id: "up-1", type: "buildUploads", attributes: { state: { state: "COMPLETE" } } } }),
    [`GET ${apple("/v1/builds")}`]: () => jsonRes({ data: state.build ? [{ id: "build-1", type: "builds", attributes: { ...state.build, expired: false, expirationDate: "2027-01-18T00:00:00Z" } }] : [] }),
    [`PATCH ${apple("/v1/builds/build-1")}`]: (c: Call) => {
      state.build!.usesNonExemptEncryption = JSON.parse(c.body!).data.attributes.usesNonExemptEncryption;
      return jsonRes({ data: { id: "build-1", type: "builds", attributes: {} } });
    },
    [`GET ${apple("/v1/builds/build-1/buildBetaDetail")}`]: () =>
      jsonRes({ data: { id: "bbd-1", type: "buildBetaDetails", attributes: { externalBuildState: state.beta ?? "READY_FOR_BETA_SUBMISSION", autoNotifyEnabled: state.autoNotify === true } } }),
    [`PATCH ${apple("/v1/buildBetaDetails/bbd-1")}`]: () => {
      state.autoNotify = true;
      return jsonRes({ data: { id: "bbd-1", type: "buildBetaDetails", attributes: { autoNotifyEnabled: true } } });
    },
    [`POST ${apple("/v1/buildBetaNotifications")}`]: () => jsonRes({ data: { id: "n-1", type: "buildBetaNotifications", attributes: {} } }, 201),
    "GET testflight.apple.com/join/AbCd1234": () => new Response(state.invitation === "open" ? JOIN_OPEN : state.invitation === "full" ? JOIN_FULL : JOIN_CLOSED, { headers: { "Content-Type": "text/html" } }),
    [`POST ${apple("/v1/betaGroups/grp-1/relationships/builds")}`]: () => new Response(null, { status: 204 }),
    [`GET ${apple("/v1/builds/build-1/betaBuildLocalizations")}`]: () => jsonRes({ data: [] }),
    [`POST ${apple("/v1/betaBuildLocalizations")}`]: () => jsonRes({ data: { id: "bl-1", type: "betaBuildLocalizations", attributes: {} } }, 201),
    // Apple refuses review until the app's primary language has a beta description.
    [`POST ${apple("/v1/betaAppReviewSubmissions")}`]: () =>
      (state.locales ?? []).includes("en-GB")
        ? jsonRes({ data: { id: "sub-1", type: "betaAppReviewSubmissions", attributes: {} } }, 201)
        : jsonRes({ errors: [{ status: "422", detail: "betaAppLocalization must exist for an app" }] }, 422),
  };
}

async function readyApp(routes: ReturnType<typeof storeRoutes>) {
  await saveAppleSecrets(env, deps, cookie);
  const d = { ...deps, fetch: fakeFetch(routes).fetch };
  expect((await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await rsaPem() }), env, d)).status).toBe(201);
  const made = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull", bundleId: "com.example.skull" }), env, d);
  const { app, buildToken } = (await made.json()) as { app: { id: string }; buildToken: string };
  const link = (await (await handle(api(cookie, "POST", `/api/dev/apps/${app.id}/links`, {}), env, d)).json()) as { link: { id: string } };
  return { appId: app.id, buildToken, linkId: link.link.id };
}

describe("TestFlight", () => {
  it("clears an old lookup error when a fresh approved-build read succeeds", async () => {
    const stub = fakeFetch(storeRoutes({ storeApp: true, build: { processingState: "VALID", usesNonExemptEncryption: false }, beta: "BETA_APPROVED", autoNotify: true }));
    const d = { ...deps, fetch: stub.fetch };
    const client = new AppleClient(env, d, { issuerId: "fixture", keyId: "fixture", privateKey: await applePem() });
    const app = { id: "fixture", ascAppId: "asc-1", platform: "tvos", betaGroupId: "grp-1" } as AppRow;
    const row: TestflightBuildRow = { id: 1, appId: app.id, platform: "tvos", version: "0.18.0", buildNumber: "1", buildId: "build-1", uploadId: null, uploadFileId: null, whatsNew: null,
      state: "approved", appleState: "BETA_APPROVED", message: "Earlier Apple resource lookup failed", notifiedAt: deps.now().toISOString(), createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() };
    await advanceBuild(client, app, row, deps.now().toISOString());
    expect(row.state).toBe("approved");
    expect(row.appleState).toBe("BETA_APPROVED");
    expect(row.message).toBeNull();
    expect(stub.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("returns workflow status on both default and explicit platform views", async () => {
    const routes = storeRoutes({ storeApp: false });
    const { appId } = await readyApp(routes);
    const github = fakeFetch({ ...routes,
      "GET api.github.com/repos/o/skull/actions/workflows": () => jsonRes({ workflows: [{ id: 11, name: "release", path: ".github/workflows/release.yml", state: "active" }] }),
      "GET api.github.com/repos/o/skull/actions/workflows/11/runs": () => jsonRes({ workflow_runs: [{ id: 123, workflow_id: 11, run_number: 9, run_attempt: 1, status: "in_progress", conclusion: null, event: "repository_dispatch", created_at: "2026-10-16T09:58:00Z", run_started_at: "2026-10-16T09:59:00Z", html_url: "https://github.com/o/skull/actions/runs/123" }] }),
    });
    const d = { ...deps, fetch: github.fetch };
    for (const suffix of ["", "/ios", "/macos", "/tvos"]) {
      const response = await handle(api(cookie, "GET", `/api/dev/apps/${appId}/testflight${suffix}`), env, d);
      expect(response.status).toBe(200);
      const view = await response.json();
      if (suffix === "/macos" || suffix === "/tvos") {
        expect(view).toMatchObject({ platform: suffix.slice(1), buildStatus: { state: "unavailable", reason: "workflow-missing", workflowName: null, runId: null, elapsedSeconds: null, platformVerified: false } });
      } else {
        expect(view).toMatchObject({ platform: suffix.slice(1) || "ios", buildStatus: { state: "running", workflowName: "release", runId: 123, elapsedSeconds: 60, expectedSeconds: null, progressPercent: null, platformVerified: false } });
      }
      expect(JSON.stringify(view)).not.toContain("ghp_");
    }
    expect(github.calls.filter((call) => call.url.includes("/actions/workflows?"))).toHaveLength(3);
  });

  it("names the developer's next step, and what to type into App Store Connect", async () => {
    type View = { setUp: boolean; needs: string | null; storeApp: { name: string; otherName: string; bundleId: string; sku: string } | null };
    const routes = storeRoutes({ storeApp: false });
    const made = await handle(api(cookie, "POST", "/api/dev/apps", { name: "Skull", repo: "o/skull" }), env, deps);
    const { app } = (await made.json()) as { app: { id: string } };
    const d = { ...deps, fetch: fakeFetch(routes).fetch };
    const view = async (method = "GET") => (await (await handle(api(cookie, method, `/api/dev/apps/${app.id}/testflight`), env, d)).json()) as View;
    expect(await view()).toMatchObject({ setUp: false, needs: "bundle-id", storeApp: null });
    await handle(api(cookie, "PUT", `/api/dev/apps/${app.id}`, { bundleId: "com.example.skull" }), env, d);
    expect((await view()).needs).toBe("apple-key");
    await saveAppleSecrets(env, deps, cookie);
    expect((await view()).needs).toBe("signing");
    await handle(api(cookie, "POST", "/api/dev/signing", { csr: CSR, privateKey: await rsaPem() }), env, d);
    expect((await view()).needs).toBe("review-contact");
    expect((await view("POST")).needs).toBe("review-contact");
    expect((await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "nope", phone: "+44 7700 900123" }), env, d)).status).toBe(400);
    expect((await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, d)).status).toBe(200);
    // Nothing is left that ourapps can check without Apple; the POST finds no App Store Connect app.
    expect((await view()).needs).toBeNull();
    const posted = await view("POST");
    expect(posted).toMatchObject({ setUp: false, needs: "store-app", storeApp: { name: "Skull", otherName: "Skull by George", bundleId: "com.example.skull", sku: "skull" } });
  });

  it("sets up, asks for the first build, answers export compliance, follows it through beta review, and offers the invitation only once it accepts testers", async () => {
    type View = { setUp: boolean; stage: string | null; invitation: { state: string | null }; buildRequest: { at: string; error: string | null } | null; builds: { state: string; message: string | null; appleState: string | null }[] };
    const state: Store = { storeApp: true };
    const routes = storeRoutes(state);
    const { appId, buildToken, linkId } = await readyApp(routes);
    const { fetch, calls } = fakeFetch({ ...githubRoutes(), ...routes,
      "GET api.github.com/repos/o/skull/actions/workflows": () => new Response("Actions access denied", { status: 403 }),
      "GET api.github.com/repos/o/skull/releases/assets/1": () => jsonRes({ ...manifest, install: { ...manifest.install, ios: { bundleId: "com.example.skull", testflight: "https://testflight.apple.com/join/OLD" } } }),
    });
    const d = { ...deps, fetch };
    await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, d);
    const view = async () => (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/testflight`), env, d)).json()) as View;
    const page = async () => ((await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d)).json()) as { release: { install: { ios: { testflight: string | null } } } }).release.install.ios.testflight;
    const latest = async () => ((await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, d)).json()) as { testflightUrl: string | null }).testflightUrl;

    // Set-up makes the profile, the group and its link, then asks the repository for the first build.
    const set = await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, d);
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ setUp: true, needs: null, storeApp: null, stage: "waiting-for-upload", url: "https://testflight.apple.com/join/AbCd1234", invitation: { state: "not-accepting" }, buildRequest: { error: null }, buildStatus: { state: "unavailable", reason: "actions-access" }, profile: "Skull App Store", contact: true, builds: [] });
    expect(await view()).toMatchObject({ buildStatus: { state: "unavailable", reason: "actions-access" } });
    const storeProfile = JSON.parse(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/profiles")).at(-1)!.body!).data;
    expect(storeProfile.attributes).toEqual({ name: "Skull App Store", profileType: "IOS_APP_STORE" });
    const review = JSON.parse(calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/betaAppReviewDetails/rev-1"))!.body!).data.attributes;
    expect(review).toMatchObject({ contactFirstName: "George", contactEmail: "g@example.com", demoAccountRequired: false });
    const asked = calls.filter((c) => c.url.endsWith("/repos/o/skull/dispatches"));
    expect(asked.map((c) => JSON.parse(c.body!))).toEqual([{ event_type: "my-store-release", client_payload: { app: appId, reason: "testflight-set-up" } }]);
    // The invitation refuses testers, so friends are not offered it; neither link from my-app.json nor ourapps'.
    expect(await page()).toBeNull();
    expect(await latest()).toBeNull();

    const auth = { Authorization: `Bearer ${buildToken}` };
    const signing = (await (await handle(api(null, "GET", `/api/build/${appId}/signing`, undefined, auth), env, d)).json()) as Record<string, unknown>;
    expect(signing).toMatchObject({ storeProfile: { profileName: "Skull App Store" }, testflight: { url: "https://testflight.apple.com/join/AbCd1234" } });
    expect((await handle(api(null, "POST", `/api/build/${appId}/testflight/upload`, { version: "1.0" }, auth), env, d)).status).toBe(400);
    const up = await handle(api(null, "POST", `/api/build/${appId}/testflight/upload`, { version: "1.0", buildNumber: "7", fileName: "skull.ipa", fileSize: 9, whatsNew: "Rematch button" }, auth), env, d);
    expect(await up.json()).toEqual({ uploadFileId: "file-1", operations: [{ method: "PUT", url: "https://upload.example/part1", offset: 0, length: 9, requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] }] });
    const commit = await handle(api(null, "POST", `/api/build/${appId}/testflight/commit`, { uploadFileId: "file-1", md5: "0123456789abcdef0123456789abcdef" }, auth), env, d);
    expect(await commit.json()).toEqual({ state: "uploaded" });
    expect(JSON.parse(calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/buildUploadFiles/file-1"))!.body!).data.attributes).toEqual({ uploaded: true, sourceFileChecksums: { file: { algorithm: "MD5", hash: "0123456789abcdef0123456789abcdef" } } });
    expect((await view()).stage).toBe("processing");

    state.build = { processingState: "PROCESSING", usesNonExemptEncryption: null };
    await tickTestflight(env, d);
    expect((await view()).builds[0].state).toBe("processing");
    // Processed without an export compliance answer: ourapps answers it, then sends the build to review.
    state.build = { processingState: "VALID", usesNonExemptEncryption: null };
    await tickTestflight(env, d);
    expect(await view()).toMatchObject({ stage: "in-review", builds: [{ state: "in-review", message: null }] });
    expect(JSON.parse(calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/builds/build-1"))!.body!).data.attributes).toEqual({ usesNonExemptEncryption: false });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/betaGroups/grp-1/relationships/builds"))).toBe(true);
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/betaBuildLocalizations"))!.body!).data.attributes).toEqual({ locale: "en-US", whatsNew: "Rematch button" });
    expect(state.autoNotify).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/betaAppReviewSubmissions"))).toBe(true);

    state.beta = "IN_BETA_REVIEW";
    await tickTestflight(env, d);
    expect(await view()).toMatchObject({ stage: "in-review", builds: [{ appleState: "IN_BETA_REVIEW" }] });
    // Approved: ourapps makes it available to the group once, as App Store Connect's Notify Testers does.
    state.beta = "BETA_APPROVED";
    await tickTestflight(env, d);
    await tickTestflight(env, d);
    expect((await view()).stage).toBe("approved");
    expect(calls.filter((c) => c.url.endsWith("/v1/buildBetaNotifications"))).toHaveLength(1);
    // Testing at Apple, but the invitation page still refuses testers: the developer is told, friends are not offered it.
    state.beta = "IN_BETA_TESTING";
    await tickTestflight(env, d);
    expect(await view()).toMatchObject({ stage: "link-closed", builds: [{ state: "open" }] });
    expect(await page()).toBeNull();
    state.invitation = "full";
    await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, d);
    expect(await view()).toMatchObject({ stage: "link-closed", invitation: { state: "full" } });
    state.invitation = "open";
    const checked = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, d)).json()) as View;
    expect(checked).toMatchObject({ stage: "open", invitation: { state: "open" } });
    expect(await page()).toBe("https://testflight.apple.com/join/AbCd1234");
    expect(await latest()).toBe("https://testflight.apple.com/join/AbCd1234");
    // The release is 0.1.0, but TestFlight has the build Apple approved: 1.0.
    const full = (await (await handle(api(null, "GET", `/api/public/links/${linkId}`), env, d)).json()) as { release: { version: string; testflightVersion: string | null } };
    expect(full.release).toMatchObject({ version: "0.1.0", testflightVersion: "1.0" });
    const upd = (await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, d)).json()) as { version: string; testflightVersion: string | null };
    expect(upd).toMatchObject({ version: "0.1.0", testflightVersion: "1.0", apple: { ios: { version: "1.0", testflightUrl: "https://testflight.apple.com/join/AbCd1234" }, macos: null, tvos: null } });
    // A new approval reaches a public read without waiting for the scheduled check.
    await env.DB.prepare("UPDATE testflight_builds SET state = 'in-review' WHERE app_id = ?").bind(appId).run();
    state.beta = "IN_BETA_REVIEW";
    deps.advance(61_000);
    const beforeRead = calls.length;
    expect((await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, d)).json()) as Record<string, unknown>).toMatchObject({ testflightVersion: null, testflightUrl: null, apple: { ios: null, macos: null, tvos: null } });
    state.beta = "IN_BETA_TESTING";
    // Reads inside the one-minute window keep the last checked answer.
    expect((await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, d)).json()) as Record<string, unknown>).toMatchObject({ testflightVersion: null });
    deps.advance(61_000);
    expect((await (await handle(api(null, "GET", `/api/public/links/${linkId}/latest`), env, d)).json()) as Record<string, unknown>).toMatchObject({ testflightVersion: "1.0" });
    expect(calls.slice(beforeRead).every((c) => c.method === "GET")).toBe(true);
  });

  it("asks the repository for a build on request", async () => {
    const state: Store = { storeApp: true };
    const routes = storeRoutes(state);
    const { appId } = await readyApp(routes);
    expect((await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight/build`), env, deps)).status).toBe(409);
    await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, deps);
    // Without a dispatch route GitHub answers 599: the set-up still succeeds and the failure is shown.
    const set = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, { ...deps, fetch: fakeFetch(routes).fetch })).json()) as { stage: string; buildRequest: { error: string } };
    expect(set.buildRequest.error).toMatch(/599/);
    expect(set.stage).toBe("no-build");
    const { fetch, calls } = fakeFetch({ ...githubRoutes(), ...routes });
    const asked = (await (await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight/build`), env, { ...deps, fetch })).json()) as { stage: string; buildRequest: { error: string | null } };
    expect(asked).toMatchObject({ stage: "waiting-for-upload", buildRequest: { error: null } });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/dispatches"))!.body!)).toEqual({ event_type: "my-store-release", client_payload: { app: appId, reason: "requested" } });
  });

  it("asks the repository for a fresh build before the latest one expires", async () => {
    const state: Store = { storeApp: true };
    const routes = storeRoutes(state);
    const { appId, buildToken } = await readyApp(routes);
    const d = { ...deps, fetch: fakeFetch({ ...routes, ...githubRoutes() }).fetch };
    await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, d);
    await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, d);
    const auth = { Authorization: `Bearer ${buildToken}` };
    await handle(api(null, "POST", `/api/build/${appId}/testflight/upload`, { version: "1.0", buildNumber: "7", fileName: "skull.ipa", fileSize: 9 }, auth), env, d);
    // The test clock is 16 October 2026; the build expires 18 January 2027: nothing to do.
    state.build = { processingState: "VALID", usesNonExemptEncryption: false };
    const quiet = fakeFetch({ ...routes, ...githubRoutes() });
    await tickTestflight(env, { ...deps, fetch: quiet.fetch });
    expect(quiet.calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
    // Ten days before expiry: one release request, and none again the same week.
    deps.advance(84 * 86_400_000);
    const due = fakeFetch({ ...routes, ...githubRoutes() });
    await tickTestflight(env, { ...deps, fetch: due.fetch });
    const sent = due.calls.filter((c) => c.url.endsWith("/dispatches"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body!)).toEqual({ event_type: "my-store-release", client_payload: { app: appId, reason: "testflight-expiry" } });
    const again = fakeFetch({ ...routes, ...githubRoutes() });
    await tickTestflight(env, { ...deps, fetch: again.fetch });
    expect(again.calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
  });

  it("adds the primary language's beta description when Apple refuses review without it", async () => {
    const state: Store = { storeApp: true };
    const routes = storeRoutes(state);
    const { appId, buildToken } = await readyApp(routes);
    const { fetch, calls } = fakeFetch({ ...routes, ...githubRoutes() });
    const d = { ...deps, fetch };
    await handle(api(cookie, "PUT", "/api/dev/review-contact", { firstName: "George", lastName: "McIntyre", email: "g@example.com", phone: "+44 7700 900123" }), env, d);
    await handle(api(cookie, "POST", `/api/dev/apps/${appId}/testflight`), env, d);
    expect(state.locales).toEqual(["en-GB"]);
    // As an app set up before: only an en-US description.
    state.locales = ["en-US"];
    const auth = { Authorization: `Bearer ${buildToken}` };
    await handle(api(null, "POST", `/api/build/${appId}/testflight/upload`, { version: "1.0", buildNumber: "7", fileName: "skull.ipa", fileSize: 9 }, auth), env, d);
    await handle(api(null, "POST", `/api/build/${appId}/testflight/commit`, { uploadFileId: "file-1", md5: "0123456789abcdef0123456789abcdef" }, auth), env, d);
    state.build = { processingState: "VALID", usesNonExemptEncryption: null };
    await tickTestflight(env, d);
    const view = (await (await handle(api(cookie, "GET", `/api/dev/apps/${appId}/testflight`), env, d)).json()) as { stage: string; builds: { state: string; message: string | null }[] };
    expect(view).toMatchObject({ stage: "in-review", builds: [{ state: "in-review", message: null }] });
    expect(state.locales).toEqual(["en-US", "en-GB"]);
    expect(JSON.parse(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/betaAppLocalizations")).at(-1)!.body!).data.attributes).toEqual({ locale: "en-GB", description: "Skull", feedbackEmail: "g@example.com" });
  });
});
