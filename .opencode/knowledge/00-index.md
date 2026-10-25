# ourapps - private link-only installer

Repo: github.com/george-mcintyre/ourapps (folder `ourapps/`; renamed from `app-game-store` on
2026-10-18, GitHub forwards the old URL). Confirm with `git remote -v`. Cloudflare resources keep
the name `app-game-store` (Worker, D1 database); see `gotchas.md`. Public repo;
privacy comes from unlisted share links, not from the code being hidden. Product definition:
`../../.opencode/knowledge/ourapps.md`.

## What it is

Developers sign in with GitHub, add apps, and create share links. A friend taps `/l/<id>`
and ends up with the app on their home screen. The store reads each app's `my-app.json`
(schema 1, owned by `@my:orchestrator`, see `../../.opencode/knowledge/app-manifest.md`)
from the latest GitHub Release and serves artefacts through signed one-hour links.

## Layout

| path          | what                                                              |
|---------------|-------------------------------------------------------------------|
| `worker/`     | Cloudflare Worker: serves `site/dist`, `/api/*`, `/dl/*`; D1 data |
| `site/`       | Vite + TypeScript, no framework, history routing                  |
| `shared/`     | `validateManifest`, `TERMS_VERSION`, screenshot sets              |
| `CONTRACT.md` | what an app repo implements (signing, TestFlight upload, publish, `my-store-release`) |

## Conventions

- Every page, document and public file carries "Copyright Level N Ltd 2026" (site footers via
  `storeFrame` and `shell`, plus README, CONTRACT.md, agents.md). Keep it when adding pages.
- Public example content uses the invented "Poker Night" app, never a real app name.
- George's physical iPhones and iPads install and update through TestFlight only; Developer Mode is off. Do not install local builds on them. Simulator builds are separate.
- User-facing text (site, guide, reference, agents.md, CONTRACT.md, README, SECURITY, messages) states only what is: no history, no "still", "older", "now", "no longer offered", no announced changes, no warnings about roads not taken. Changelogs and the example app's invented release notes are the exception. Owner's standing rule.

## Where to change X

- Existing upload continuation metadata: POST `/api/build/:app/:platform/testflight/upload/:file/operations`, `buildUploadFileOperations` and `worker/src/upload-operations.ts`. Requires HTTPS, app token, owned uploading record/version/build and Apple AWAITING_UPLOAD/size. Validates sorted-copy range coverage but preserves returned order. Signed URLs/header values are returned only to the authorized uploader, no-store and memory-only; this retrieval makes no writes/reservations/commit. The client sorts validated operations before byte writes and commits the same file.

- Read-only upload diagnosis: `buildUploadFileStatus` in `worker/src/routes/build.ts`, `sanitiseUploadFile` in `worker/src/upload-diagnostic.ts`; GET `/api/build/:app/:platform/testflight/upload/:file/status` scopes app build token and existing upload ownership. Reads Apple metadata, exposes bounded state/method/offset/length/type/coverage plus host/header names only, and skips token rewrite and credential rewrap. It never resumes, reserves or commits an upload.

- Verified workflow reservation associations are in migration0017 and the reservation/status helpers in `worker/src/github.ts` and `testflight.ts`. Optional runId/runAttempt metadata is checked against GitHub before allocation; same-attempt retries reuse the pair. Unknown upload receipt is null and the console must never label that as absent. Bodyless reservation clients remain valid.

- Mac/TV workflows without dashboard-reserved inputs POST `/api/build/:app/:platform/testflight/reserve-build` with the existing app build token. `reservePlatformBuild` in `worker/src/testflight.ts` is shared with dashboard dispatch, returning version/buildNumber strings without dispatching. Migration0016 supplies atomic reservation; supplied dashboard inputs must skip the reservation call. Route tests cover cross-app rejection and concurrent dashboard/token allocations.

- GitHub build status: `loadBuildStatus` in `worker/src/github.ts`, exposed as `buildStatus` by TestFlight views; `site/src/buildStatus.ts` refreshes every visible 30 seconds. iOS matches `release.yml`; Mac/TV require `apple-testflight.yml` and canonical `Apple TestFlight macos|tvos VERSION (BUILD)` titles. `platformVerified` identifies only the title's platform, not app/request identity. Successful runs without matching upload evidence display Finished without upload. Cache API stores sanitized status15s/timings15min. Mac/TV dispatch uses Actions write, iOS uses Contents write, status uses Actions read; atomic per-app/platform/version build reservations are in migration0016.

- iPhone/iPad compatibility on Apple-silicon Mac is separate from Catalyst/native Mac. `release.apple.iosOnMac` and `/latest.apple.iosOnMac` require iOS readiness plus Apple's beta-group permission flag; `apps.ios_on_mac` and `ios_on_mac_checked_at` cache that flag for one minute (migration 0015). `site/src/desktop.ts` labels the compatibility invitation explicitly. No Intel claim or `macos` readiness fallback.

- Apple platform routing: `worker/src/apple-platform.ts` validates `ios`, `macos`, `tvos`; explicit `/api/build/:app/:platform/signing` and `/testflight/{upload,commit}`. Legacy build routes are iOS-only aliases. `worker/migrations/0014_apple_platforms.sql` stores separate platform state and installer certificates; Mac installer keys use the encrypted `installerSigningKey` field. Mac setup defaults to Catalyst (`MAC_CATALYST_APP_STORE`); native Mac is `MAC_APP_STORE`; TV is `TVOS_APP_STORE`. Console setup/status: `/api/dev/apps/:id/testflight/:platform`. Real signed export/upload and tester availability require platform-specific verification.
- Desktop delivery: `shared/src/desktop.ts` and `manifest.ts` validate package and Apple target declarations; `worker/src/flow.ts` signs `.dmg`/`.exe` downloads, `routes/public.ts` streams them; `download-filename.ts` preserves safe response filenames, falling back to a URL basename or generic name; `site/src/desktop.ts` renders package requirements and Apple TV instructions. `release.apple` and `/latest.apple` expose only each platform's approved version and open invitation. Declaring a target does not make TestFlight installable. Direct installer updates use `/latest.macos` and `.windows` package metadata, independently of TestFlight approval.

- Routes: `worker/src/index.ts`. Handlers: `worker/src/routes/{public,build,dev}.ts`.
- Sign-in and sessions: `worker/src/auth.ts`. Encrypted credentials: `worker/src/secrets.ts`, `worker/src/crypto.ts`.
- Apple calls: `worker/src/apple.ts`, client from `appleClient` in `worker/src/flow.ts`; repository dispatch: `worker/src/github.ts`.
- iPhone distribution is TestFlight only. Per-device Ad Hoc registration was removed on the owner's instruction (its builds need Developer Mode since iOS 16; migration 0011 dropped its tables); do not bring it back: `worker/src/testflight.ts` (set-up, upload broker, the 10-minute cron `tickTestflight` that distributes processed builds and sends `my-store-release` before the 90-day expiry), Apple calls in `worker/src/apple.ts`, migration 0010, routes `/api/dev/apps/:id/testflight`, `/api/dev/review-contact`, `/api/build/:app/testflight/{upload,commit}`; install page card `testflightSteps` in `site/src/pages/public.ts`; console card `testflightCard` in `site/src/pages/dev.ts` (a step list driven by `needs`; for `store-app` it lists Apple's New App form with the values in `storeApp` and checks with Apple every 15 seconds while visible, for up to 20 minutes; after set-up a second step list driven by `stage`, from the first build to an open invitation). Each build is followed to Apple's `externalBuildState` (`advanceBuild`); the invitation page at testflight.apple.com is read (`checkInvitation`) and the install page offers the link only when it is open (`openInvitation` in `worker/src/routes/public.ts`). Set-up sends `my-store-release` for the first build. Export compliance is answered automatically for every build (`usesNonExemptEncryption` false, owner's decision of 2026-10-22; the terms make it the developer's to keep true); there is no step or status for it. Apple has no API to create the App Store Connect app record; the developer adds it once.
- iPhone signing: the browser makes the RSA key and CSR (`site/src/signing.ts`); `POST /api/dev/signing` (`setUpSigning` in `worker/src/routes/dev.ts`) gets an Apple Distribution certificate, stores the key as the `signingKey` secret and the certificate in `signing_certificates` (migration 0006), and makes the App Store profile again (`renewStoreProfile`, `worker/src/testflight.ts`) for apps already on TestFlight; builds fetch everything from `GET|HEAD /api/build/:app/signing` (`worker/src/routes/build.ts`), 404 until TestFlight is set up. Settings card in `site/src/pages/dev.ts`.
- Schema: `worker/migrations/*.sql`; queries: `worker/src/db.ts`.
- Example story and mock install page: `site/src/pages/example.ts` (routes `/example`, `/example/poker-night`).
- Site pages: `site/src/pages/public.ts` (store theme: landing, developer page, install, preview), `site/src/pages/dev.ts` (console: overview, apps, form, links, settings, agents), `site/src/pages/guide.ts` (A to Z guide), `site/src/pages/shell.ts` (console frame), `site/src/pages/prompts.ts` (agent prompts).
- Design tokens and both themes: `site/src/style.css` (`[data-theme="store"]`, `[data-theme="dev"]`, dark variants). Placeholders: `site/src/placeholders.ts`. Shared components and icons: `site/src/ui.ts`.
- Terms and data statement: `site/src/pages/terms.ts`; version constant `shared/src/terms.ts` (bump to force re-acceptance); gate `requireTerms` in `worker/src/auth.ts`; acceptance stored on `developers`.
- Security model and rotation: `SECURITY.md`. Crypto primitives: `worker/src/crypto.ts`; credential envelopes: `worker/src/secrets.ts`; audit log: `worker/src/audit.ts`.
- API keys and bearer auth: `worker/src/auth.ts`, `worker/src/routes/dev.ts` (`listKeys`, `createKey`, `revokeKey`, `releaseStatus`, `previewApp`).
- Screenshots per version: storage `apps.screenshots_by_platform` (migration 0005); sets built in `buildLinkPage` (`worker/src/routes/public.ts`); choice of list `pickScreenshots` (`shared/src/screenshots.ts`); versions, tabs and shapes `site/src/views.ts`; panels and carousels in `renderInstall` (`site/src/pages/public.ts`).
- Revision history (releases, tags, commit fallback, 2 minute cache): `worker/src/history.ts`; rendering: `historyBlock` in `site/src/pages/public.ts`, notes to HTML in `site/src/notes.ts`.
- Web apps: new ones are deployed by the app's workflow to the developer's own Cloudflare account (files-only Worker, contract.md "Web apps"); `install.pwa` holds that address, `webHosting` (`worker/src/webapp.ts`) reports it in the release status, and the banner is published from `worker/src/assets/install-banner.js` to `site/public/web/install-banner.js` by the site `prebuild`. Older `web.zip` hosting on `https://<linkId>.ourapps.app/`: `worker/src/webapp.ts` (host detection, limits `WEB_LIMITS`, unpack once per release into ~2 MB packs in KV `WEBAPP_FILES`, edge cache per file, `.br`/`.gz` encodings, `_headers` allowlist, SPA fallback); route `*.ourapps.app/*` in `worker/wrangler.jsonc` needs the wildcard proxied AAAA record on the zone.
- Technical reference page (public, `/reference`): `site/src/pages/reference.ts`; inline SVG architecture diagram as fallback; generated diagrams in `site/public/reference/` as PNG masters plus WebP copies (`cwebp -q 92 -m 6`), shown through `diagram()` with a full-size link; prompts in `docs/diagram-prompts.md`. The guide overview reuses `architecture`. Keep the page's limits in step with `WEB_LIMITS`.
- Agent documents: `site/public/agents.md`, `site/public/llms.txt`; `CONTRACT.md` is copied to `site/public/contract.md` by the site `prebuild` script. `site/src/freeTiers.ts` is the single source for the guide's free-services section, `/small` and `site/public/free-tiers.md` (generated by `site/scripts/free-tiers-md.ts` in `prebuild`, gitignored).
- Platform and in-app browser detection: `site/src/platform.ts`. Paths: `site/src/router.ts`.

## Build, test, run

- `npm install` at the root (workspaces `shared`, `worker`, `site`).
- `npm test` runs all three; `npm run typecheck` likewise.
- Local: `cd worker && npx wrangler d1 migrations apply app-game-store --local`, then
  `npm run build -w site && npm run dev -w worker` on http://localhost:8787.
- Deploy: `npm run build -w site && cd worker && npx wrangler deploy`. See `workflow.md`.

Details: `workflow.md`, `gotchas.md`.
