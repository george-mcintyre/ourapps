# ourapps.app for agents

ourapps.app is a private installer: developers register apps they built for friends and family, create share links, and friends install from those links. This document is the complete reference for driving it programmatically. Everything the web console does is available through this API.

Base URL: `https://ourapps.app`. All request and response bodies are JSON. Errors are `{"error": "message"}` with a 4xx or 5xx status.

Related: the repository contract at `https://ourapps.app/contract.md` describes what an app's GitHub repository must publish and the calls its workflow makes.

## Authentication

Send `Authorization: Bearer <api key>` on every `/api/dev/*` request. Keys start with `oa_` and are created by the developer in the console at `/dev/agents`. A key acts as that developer within its scope; everything is scoped to their apps and links.

- Scope `manage` allows every method; scope `read` allows only GET and returns 403 `this API key is read-only` otherwise.
- Keys may carry an expiry (default 90 days when created in the console); an expired or revoked key gets 401.
- A key can never create or revoke keys, change credentials (`PUT /api/dev/secrets`), or sign out sessions. Those need the developer in a browser.
- Keys are stored as keyed hashes; treat yours as a password and never write it to a file or a log.

Check who you are:

```
GET /api/dev/me
-> { "developer": { "id", "slug", "displayName", "githubLogin", "createdAt" }, "authVia": "key",
     "secrets": { "github": true, "githubSavedAt": "...", "apple": false, "appleSavedAt": null, "appleTeamId": "", "appleTeamIdSavedAt": null } }
```

`secrets.github` false means the developer has not saved a GitHub token; the console cannot read private release assets or ask for fresh builds until they do (only they can do that, at `/dev/settings`). `secrets.apple` false means TestFlight cannot be set up.

The developer's GitHub token needs Contents read and write for releases and iOS build requests, plus Actions read for workflow status and successful-run timing. Mac/Apple TV requests use Actions write and private-release Contents read. `buildStatus` reports unavailable with guidance when status permissions are missing.

## Supported app types (summary)

### Desktop package specification

The install page offers matching Mac and Windows packages alongside the web version, with explicit architecture and minimum-system choices. Publish metadata verified against the actual package.

Optional `install.macos` and `install.windows` are null or `{ "packages": [...] }`. Every package has `url` (HTTPS release asset), `format`, `architectures` (non-empty unique list of `arm64` and/or `x64`), `minOsVersion`, and `signing` (`unsigned` or `signed`). Windows requires a non-empty package list; Mac permits an empty list with a valid TestFlight declaration. macOS requires `format: "dmg"` and `notarization: "notarized" | "not-notarized"`; Windows requires `format: "exe"` and must omit notarization. Reject unknown enum values and non-HTTPS URLs. Publish only verified architecture, minimum-system and signing claims; separate architecture-specific installers are separate packages. Missing/null targets offer no download. Package links are ordinary download links; operating-system checks apply regardless of signing status.

Optional `screenshotsByPlatform.macos`, `.windows` and `.tvos` use the existing screenshot fallback rules. Reject Mac packages claiming both unsigned and notarized. Full package examples: contract.md, Desktop package specification.

### Apple platform specification

Read-only distribution diagnosis: `GET /api/build/:app/:platform/testflight/distribution` with that app's build token reads Apple's configured group and up to six recorded platform builds. No-store success is `{platform,checkedAt,group:{id,isInternalGroup,publicLinkEnabled,publicLinkMatchesConfigured,recordedInvitationState,testerCount},builds:[{version,buildNumber,buildId,recordedState,externalBuildState,autoNotifyEnabled,inConfiguredGroup,notifiedAt}]}`. Group membership and tester count are null when incomplete data cannot establish them. No tester identities, invitation addresses, credentials or upload capabilities are returned. This performs Apple GET requests only, without token rehash, credential rewrap, notifications or local state changes, and remains readable for disabled targets. Missing setup returns409; Apple lookup failure502 returns only `{error:"Apple distribution lookup failed",appleStatus:number|null}`. These fields are diagnostic evidence, not a tester installation check.

Existing-file continuation metadata: HTTPS `POST /api/build/:app/:platform/testflight/upload/:file/operations` with per-app bearer build token and `{version, buildNumber, fileSize}` (version/build strings, positive safe-integer size). Checks exact app/platform/file ownership, local uploading state/version/build, Apple AWAITING_UPLOAD state, not uploaded, and Apple recorded size. No-store success is `{platform,version,buildNumber,fileSize,uploadFileId,operations}`; operations include signed URL/header values for the authorized uploader's memory only, never logs/cache/artifacts. Service validates full sorted-copy coverage while preserving original order. The client rechecks preserved signed package/hash/size/version/build, validates every operation, sorts a copy by offset, sends the exact ranges without redirects/retries, then commits the SAME existing file. No new reservation/build. This operation retrieval itself makes only an Apple GET and no record/credential writes. Error400 malformed/HTTP,401 auth,404 ownership,409 state/identity/size,502 Apple lookup/invalid operations; errors omit sensitive fields.

Read-only upload diagnosis: `GET /api/build/:app/:platform/testflight/upload/:file/status` with that app's bearer build token. Only an existing app/platform-owned file is accessible. No-store success shape is `{ platform, version, buildNumber, uploadFileId, recordedState, appleFile: { assetDeliveryState, uploaded?, fileSize, fileSizeType, operationCount, operationsTruncated, operations, coverage } }`. Each operation has `method`, `offset`, `length`, `types` (method/offset/length/url/requestHeaders), `https`, `hostname`, `headerNames`, `headerNamesTruncated`. Types are missing/null/array/object/string/number/boolean. Numeric values or bounded numeric strings retain their types; invalid values become null. Coverage has `expectedFileSize`, `fileSizeValid`, `numericValid`, `sortedContiguous`, `nonOverlapping`, `originalOrderContiguous`, `coveredBytes`, `complete`. Limits: 128 operations, 32 header names per operation. No addresses, header values, checksums, asset tokens or keys are exposed. The route makes only an Apple GET and no local record/credential writes. Invalid auth returns401; unknown/cross-app/platform file404; Apple lookup failure502 with only the static error and `appleStatus` number or null.

Manual Mac/TV workflows can POST `/api/build/:app/:platform/testflight/reserve-build` using the existing per-app bearer build token, with no body. It returns only `{ version: string, buildNumber: string }`, with `Cache-Control: no-store`, and does not dispatch a workflow. The same validated-manifest/Apple-reconciliation/atomic allocator serves dashboard requests. Reserve once inside the executing job only when no reserved version/build inputs were supplied; dashboard inputs skip reservation. No iOS reservation alias exists. Failed later work consumes the reserved number; retries reserve another number. Invalid/cross-app tokens return 401, missing setup 409, incomplete reconciliation 502.

Optional reservation body `{runId, runAttempt}` links the pair to a verified GitHub workflow attempt. Both values are required together, as positive decimal strings or safe positive integers. Repository, workflow, run, attempt and platform are checked server-side. Same-attempt retries reuse the pair after verification; different attempts allocate separately. The response stays unchanged. Bodyless clients have no run association. `uploadReceived` is null when the run's version/build is unknown, false when the identified pair has no matching upload row, and true only with matching platform/version/build and receipt-time evidence. `correlation: "reservation"` denotes a verified stored run-attempt association. Use a descriptive application User-Agent; default Python urllib identification can be rejected by Cloudflare before route authentication.

`release.apple.iosOnMac` and `/latest.apple.iosOnMac` are null or `{ version, testflightUrl }`. This is an explicitly verified iPhone/iPad compatibility version for Macs with Apple silicon, not the native/Catalyst `macos` path. It requires a ready external iOS build and open invitation and that beta group's `iosBuildsAvailableForAppleSiliconMac` flag to be true; false/unknown/unavailable means null. No Intel support is implied.

Public update specification: `/api/public/links/:id/latest` adds `apple: { ios, macos, tvos }`. Each entry is null or `{ version, testflightUrl }`, requiring that exact platform's build to be available for external testers and its invitation open. Existing `testflightVersion` and `testflightUrl` are iOS-only aliases. No platform falls back to another platform's approval or to the latest GitHub version. Direct package updates use their own release/package version and signed download URLs.

The console has separate Mac and Apple TV setup/status cards, independent of direct packages. Optional `install.macos.testflight` is `{ bundleId, minOsVersion, architectures }`, with non-empty unique architectures drawn from `arm64` and `x64`. Mac packages may be empty only with a valid TestFlight declaration. Optional `install.tvos` is null or `{ bundleId, minOsVersion }`. Declare only verified system and architecture support. A declaration alone does not make an invitation available.

Mac downloads: open the .dmg, drag the app to Applications; quit and replace it to update. Windows downloads: run the .exe installer, run the new installer to update, and uninstall through Settings, Apps, Installed apps. Signed/unsigned and Mac notarization labels report package metadata. System checks and organisation policy apply to both signed and unsigned apps; Windows Application Control may block installed unsigned apps. Never advise bypassing policy.

Apple TV public invitation: install TestFlight on iPhone or iPad and Apple TV with the same App Store account, accept the public invitation on iPhone or iPad, then install from TestFlight on Apple TV with the remote. Email invitations use Apple's redemption-code flow instead. Source and system requirements: https://testflight.apple.com/. Board/player modes belong to the app, not the manifest.

Apple records are separate for `ios`, `macos` and `tvos`, including signing, upload, review, invitation readiness and approved versions. Platform-specific addresses are `GET|HEAD /api/build/:app/:platform/signing` and `POST /api/build/:app/:platform/testflight/upload` or `/commit`. Existing addresses remain iOS-only aliases. Unknown platforms fail explicitly, never falling back to iOS credentials. Developer ID signing/notarization for direct Mac downloads and Mac TestFlight distribution signing are distinct paths.

Full detail: https://ourapps.app/reference.

- Native iPhone and iPad through TestFlight (an App Store-signed .ipa that the workflow uploads through ourapps; friends install with Apple's TestFlight app from an invitation link), native Android (signed universal .apk; no .aab), and anything that compiles to those (Flutter, React Native, .NET MAUI, Capacitor, Kotlin Multiplatform, Unity and Godot mobile).
- Static web apps and web games: the release workflow deploys the build to the developer's own free Cloudflare account (`npx wrangler deploy`, files only, with repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) and writes the address into `install.pwa`; contract.md "Web apps" has the exact files and steps. ourapps links to it and never proxies it. A release asset named `web.zip` is served by ourapps on `https://<linkId>.ourapps.app/` and counts against ourapps' shared allowance, so deploy web apps to the developer's Cloudflare account.
- Web apps needing a server: host them yourself and put their URL in `install.pwa`.
- Backends, APIs and databases are never hosted by ourapps; apps call them directly. Allow the web app's address in CORS and authenticate with tokens, not cookies.

## Free services for the app's backend

https://ourapps.app/free-tiers.md lists services whose free plans fit apps with a few dozen users (realtime servers, video calls, databases, sign-in, AI, notifications, email, maps, analytics, builds, hosting), each with limits, catches, setup steps and secret names. Re-check the linked source before relying on a number. A developer's personal AI subscription (Claude, ChatGPT, Gemini, Copilot) must never be used to serve the app's users.

## What the developer must do themselves

Tell the developer plainly when a task is theirs; do not try to work around it:

- Signing in with GitHub, and creating the GitHub fine-grained token and the Apple App Store Connect API key (saved at `/dev/settings`; there is no API for credentials).
- iPhone signing, which runs by itself when the Apple key is saved ("Set up iPhone signing" at `/dev/settings#signing` if it did not finish), saving the TestFlight review contact at `/dev/settings#review-contact`, and adding each iPhone app once in App Store Connect (Apple has no API for it; the TestFlight card on the app's page in the console lists every field of Apple's New App form). After that `POST /api/dev/apps/:id/testflight` does the rest; the repository needs no Apple secrets.
- Providing the Android keystore and its passwords; you may store them with `gh secret set` once handed over.
- Web apps: creating a free Cloudflare account and a token from the "Edit Cloudflare Workers" template, then the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (you may run `gh secret set` once handed the values). ourapps never holds them.
- Creating API keys (browser session only).
- Anything Apple's beta review asks.
- Sending share links to people.

## Concepts

- App: a listing plus a GitHub repository. Has an opaque `id` (used by the repository as `STORE_APP_ID`) and a build token (used by the repository as `STORE_BUILD_TOKEN`; returned once on creation).
- Release: the latest GitHub Release of the repository. The console reads the asset named `my-app.json` and follows the URLs inside it. Never cached.
- Share link: `/l/<linkId>`, random, revocable, optional expiry. Friends open this.

## Apps

```
GET  /api/dev/apps
-> { "apps": [ App & { "releaseIcon": "https://ourapps.app/dl/..." | "" } ] }

POST /api/dev/apps
body: { "name": "Poker Night", "repo": "owner/name", "bundleId": "com.yourname.pokernight",
        "tagline": "", "description": "", "whatsNew": "", "privacySummary": "",
        "size": "", "minOs": "", "ageNote": "", "iconUrl": "", "screenshots": [],
        "screenshotsByPlatform": { "iphone": [], "ipad": [], "android": [], "web": [] }, "manifestUrl": "", "showOnPage": false }
-> 201 { "app": App, "buildToken": "48 hex chars, shown once" }

GET  /api/dev/apps/:id
-> { "app": App, "links": [ShareLink] }

PUT  /api/dev/apps/:id        body: any subset of the POST fields -> { "app": App }
DELETE /api/dev/apps/:id      -> { "ok": true }   (also deletes its links; the app stays in App Store Connect)
POST /api/dev/apps/:id/build-token  -> { "buildToken": "new token, shown once" }  (old token stops working)
GET  /api/dev/apps/:id/testflight   -> TestFlight
POST /api/dev/apps/:id/testflight   -> TestFlight  (sets up and asks the repository for the first build; once set up, checks with Apple now; body {"repair": true} runs the set-up again)
POST /api/dev/apps/:id/testflight/build  -> TestFlight  (asks the repository for a release now; 409 before set-up)
GET  /api/dev/apps/:id/testflight/:platform -> TestFlight (macos or tvos)
POST /api/dev/apps/:id/testflight/:platform -> TestFlight (setup/check; macos requires browser session; optional nativeMac boolean selects native Mac rather than Mac Catalyst signing)
POST /api/dev/apps/:id/testflight/:platform/build -> TestFlight (asks for that platform's build)
PUT  /api/dev/review-contact        body: { "firstName", "lastName", "email", "phone" }  (who Apple's beta review contacts)
```

TestFlight: `{ "platform", "profileType", "setUp", "needs", "storeApp", "stage", "url", "invitation": { "state", "checkedAt" }, "buildRequest": { "at", "error" } | null, "profile", "contact", "builds": [ { "version", "buildNumber", "state", "appleState", "message", "uploadedAt", "submittedAt", "expiresAt", "updatedAt" } ] }`. `needs` is `bundle-id`, `apple-key`, `signing`, `review-contact`, `store-app` or null. With the target enabled, `setUp` false and `needs` null, POST to check with Apple. For Mac and Apple TV, add the platform to the existing App Store Connect record; the default bundle identifier is the registered app's `bundleId`. Mac setup provisions the installer signing key on the server. `stage` is `no-build`, `waiting-for-upload`, `processing`, `in-review`, `approved`, `link-closed`, `rejected`, `failed` or `open`. `invitation.state` is `open`, `not-accepting`, `full`, `missing` or null. Only a matching ready platform build and open invitation expose an install link. Mac setup needs a signed-in browser. Body `{ "repair": true }` repeats setup; changing Mac profile type after setup also requires repair.

Field rules: `name` required; `repo` must be `owner/name`; `bundleId` is the Apple bundle identifier (`com.yourname.app`) and the default for each Apple platform's setup; `iconUrl`, `manifestUrl` and every screenshot must be https URLs; at most 10 screenshots per list; `screenshotsByPlatform` keys are `iphone`, `ipad`, `android`, `web`, `macos`, `windows`, `tvos` (empty lists are dropped); `showOnPage` lists the app, details only, on the developer's public page.

App object: `{ id, developerId, name, tagline, description, whatsNew, size, minOs, ageNote, privacySummary, iconUrl, screenshots, screenshotsByPlatform, repo, manifestUrl, bundleId, ascAppId, testflightUrl, showOnPage, targets, createdAt, updatedAt }`.

## Target selection

`App.targets` contains six booleans: `ios` covers iPhone and iPad together, `android`, `web` maps to `install.pwa`, `macos` covers packages and TestFlight, `windows`, and `tvos` covers Apple TV. Successfully read existing and new app preferences default to enabled; failed reads stop target work. Enabled does not mean declared, configured or ready.

```http
PUT /api/dev/apps/:id/targets/:target
body: { "enabled": false }
-> { "targets": { "ios": true, "android": true, "web": true, "macos": true, "windows": true, "tvos": false } }

GET /api/build/:app/targets
Authorization: Bearer <STORE_BUILD_TOKEN>
-> { "targets": { "ios": true, "android": true, "web": true, "macos": true, "windows": true, "tvos": false } }
```

Both responses use `Cache-Control: no-store`. The write requires ownership and a browser session or `manage` developer key; `read` keys receive 403. Browser writes retain the session origin and accepted-terms checks. Accept exactly one `enabled` boolean, with no extra fields; malformed bodies and unknown targets return 400. App build tokens cannot write preferences. The read accepts only that app's existing build token; absent, invalid, cross-app and rotated tokens receive 401. Reads do not rotate tokens or change credentials.

On the app page, use the switch beside each target heading. Disabled sections keep their setup, release information and history, greyed but readable. Disabled delivery options disappear from share pages, preview and update metadata; iPhone/iPad compatibility on Mac needs both `ios` and `macos`. All disabled leaves the listing and screenshots with no install options. The private release-status endpoint retains the published target information.

Authenticated new setup, repair, build requests, signing GET/HEAD including iPhone aliases, build-number reservation, new upload, upload-operation retrieval and commit return 409 with exactly `{ "error": "Target is disabled." }`, no-store. Status/history reads and processing/review of already uploaded builds continue. Setup, credentials, source manifests and artifacts are retained. Saving or re-enabling dispatches no build or setup; re-enabling restores currently available options and normal scheduled expiry renewal resumes while enabled.

Issued signing material, upload operations and download links remain usable, as do existing Apple invitations and hosted addresses. Selection does not revoke access or cancel external requests already in flight. Repository workflows read current flags inside every target job, skip disabled work, stop on failed or malformed reads, and preserve disabled artifacts/declarations during partial releases. See contract.md for the workflow contract.

After creating an app, store the token and id in the repository at once, passing the values on standard input so they never appear on a command line:

```
printf '%s' "$BUILD_TOKEN" | gh secret set STORE_BUILD_TOKEN --repo owner/name
printf '%s' "$APP_ID" | gh secret set STORE_APP_ID --repo owner/name
```

Never print the build token or put it in a file or a chat: it lets its holder fetch the developer's iPhone signing key. If it cannot be stored (no `gh`, no access, the repository does not exist yet), say so and drop it; once the repository is ready, `POST /api/dev/apps/:id/build-token` makes a new one to store.

## Release status

TestFlight status responses also include `buildStatus`: `state` is `not-started`, `requested`, `pending`, `running`, `complete`, `failed`, `cancelled` or `unavailable`. The object supplies `workflowName`, `runUrl`, `runNumber`, `runAttempt`, `conclusion`, `requestedAt`, `startedAt`, `checkedAt`, `elapsedSeconds`, `expectedSeconds`, `estimateSampleCount`, `progressPercent`, `correlation`, `platformVerified`, `reason` and `message`. A running estimate uses the median of up to five successful runs of the selected workflow, from run start to actual job completion. Without samples the estimate is null. Progress stays below 100 until GitHub reports success.

Mac/TV matching requires `apple-testflight.yml` and canonical display title `Apple TestFlight macos|tvos VERSION (BUILD)`, with `correlation: "platform-title"` and `platformVerified: true` for that title's platform only. App/request association remains approximate. iOS uses `release.yml` with request-time or uploaded-build-number matching. Manual Apple build input is separate from GitHub `run_number`. `uploadReceived` reports a matching platform/version/build upload row within the run window, not verified run identity; successful workflow state without it uses `reason: "workflow-complete-no-upload"` and displays Finished without upload. Status is cached at the edge for 15 seconds, successful historical run/attempt durations for 15 minutes; no credentials are cached. The console refreshes the panel every visible 30 seconds and on return to the page.

```
GET /api/dev/apps/:id/release
-> { "ok": true, "githubToken": true, "appleKey": true,
     "web": { "hosting": "own", "url": "https://poker-night-web.you.workers.dev/", "ok": true, "status": 200 } | { "hosting": "ourapps", ... } | null,
     "tag": "v0.1.1", "publishedAt": "...", "assets": ["my-app.json", "icon.png", "poker-night.apk"],
     "manifestUrl": "https://api.github.com/repos/.../assets/123", "version": "0.1.1",
     "install": { "ios": false, "android": true, "pwa": false }, "screenshots": 3, "changelog": true, "errors": [] }
-> { "ok": false, ..., "errors": ["no release visible on owner/name: the repository does not exist, has no published release yet, or is private and needs a GitHub token in Settings"] }
```

Use this after every publish. Typical errors and what fixes them:

| error contains | fix |
|---|---|
| `no release visible` | GitHub answers the same for a missing repository, one without a published release, and a private one the store cannot see. Tell them apart with `gh repo view owner/name` and `gh release list --repo owner/name`; a private repository needs the developer to save a GitHub token at /dev/settings (you cannot) |
| `does not include this repository` | the developer adds the repository to their fine-grained GitHub token on GitHub |
| `no published release visible` | publish the release, or add the repository to the developer's GitHub token; publish it (create it as a draft, upload every asset with my-app.json last, then publish; never a pre-release) |
| `has no asset named my-app.json` | upload the file with exactly that name |
| `is invalid:` | the field named in the message; see schema below |

## Preview

```
GET /api/dev/apps/:id/preview
-> { "preview": true, "linkId": null, "developer": {...}, "app": {...},
     "release": { "version", "minPlayers", "maxPlayers", "install", "fallbackName", "fallbackIcon", "fallbackDescription", "fallbackScreenshots" } | null,
     "releaseError": null | "message", "screenshots": {...}, "history": [...] }
```

When `release` is null the install page shows the listing with "has no published build yet" and no install button; `releaseError` in the preview says why. `GET /api/public/links/:id` returns the same shape without `preview`, and its `releaseError` is only "no published build yet", never the reason.

The same data the install page renders, so you can confirm icon, screenshots and text are in place. Both this and the public link endpoint include `screenshots`: a required `all` list and optional `iphone`, `ipad`, `android`, `web`, `macos`, `windows`, `tvos` lists, with private release images on signed links. Each version prefers its dashboard list, its manifest list, the dashboard general list, the manifest general list, then the closest other version. A lone list covers every platform; no images produces generated previews. `release.apple` contains the matching ready Apple invitations and their versions. Both also include `history`: one entry per published release (`version`, `tag`, `title`, `notes`, `date`, `sha`, `releaseUrl`, `commitUrl`), with notes from `CHANGELOG.md`, then the release body, then the commit message. GitHub links appear only for public repositories.

## Release notes

Friends see the revision history on the install page, so every release needs notes written for them. The mechanism: keep `CHANGELOG.md` at the repository root in Keep a Changelog form (`## [1.2.0] - 2026-10-17` sections, newest first, an `[Unreleased]` section allowed); the release workflow uploads `CHANGELOG.md` as a release asset and uses the version's section as the release body, failing when the section is missing. Draft the entry from the commits in plain words (what changed for the people using the app, not file names), then ask the developer to approve the wording. `GET /api/dev/apps/:id/release` returns `changelog: false` when the latest release did not ship the file.

## Share links

```
POST /api/dev/apps/:id/links      body: { "label": "Mum and Dad", "expiresAt": "2027-01-01T00:00:00Z" | null }
-> 201 { "link": { "id", "appId", "developerId", "label", "createdAt", "expiresAt", "revokedAt" }, "url": "https://ourapps.app/l/<id>" }

PUT /api/dev/links/:id            body: { "label": "Thursday table" } -> { "link": {...} }   (label only; the address does not change)
POST /api/dev/links/:id/revoke    -> { "ok": true }
DELETE /api/dev/links/:id         -> { "ok": true }

GET /api/public/links/:id         (no auth) -> install page data (the preview shape, see above), 410 when expired or revoked, 404 when unknown
GET /api/public/links/:id/qr.svg  (no auth) -> SVG QR code of the link
GET /api/public/links/:id/latest  (no auth) -> { "name", "version", "testflightUrl": string | null, "testflightVersion": string | null, "android": { "apkUrl" } | null, "pwa", "linksExpireAt" }
                                  "pwa" is the URL to open: https://<linkId>.ourapps.app/ when the release ships web.zip, else the manifest's own URL, else null
```

Give the developer the `url`; one link per person or group is the convention so links can be revoked one at a time.

`/latest` returns 503 `{"error": "no release of this app is available right now"}` when no release can be read (none published, or the developer's GitHub token cannot see the repository); treat that as "no update". It is what an installed app polls to offer updates: compare `version` with the running version, then open `android.apkUrl`, or `testflightUrl` on iPhone (TestFlight also updates the app by itself). On iPhone compare with `testflightVersion`, the newest build Apple has approved, which can be older than `version` while a new one is in beta review. The signed links inside are good for one hour, so fetch right before opening. Recommend a dedicated link labelled "In-app updates" that is never revoked.

## Limits worth telling the developer

- Apple: TestFlight takes up to 10,000 people per app through the public link; each build lasts 90 days (while enabled, ourapps sends `my-store-release` two weeks before expiry); Apple's beta review checks the first build of each version. Universal iPhone and iPad apps need no extra fields; build one .ipa with TARGETED_DEVICE_FAMILY 1,2.
- Android and web: no device limit.
- Android does not auto-update; friends tap Update. TestFlight updates iPhone apps. Version numbers must increase and the Android signing key must stay the same.

## Terms

A developer must accept the current terms (`/terms`) in a browser before `/api/dev/*` works for their session; API keys are not gated by the terms. `GET /api/dev/me` returns `termsVersion` and `developer.termsAcceptedVersion`. `DELETE /api/dev/me` (dashboard only, body `{"confirm": "<github login>"}`) removes the account and everything under it.

## Developer settings

```
PUT /api/dev/me        body: { "slug": "george", "displayName": "George" }   (manage scope)
PUT /api/dev/secrets   dashboard only; returns 403 for API keys
POST /api/dev/signing  dashboard only; the browser makes the key and certificate request
GET /api/dev/audit     -> { "events": [ { "event", "detail", "country", "createdAt" } ] }   (recent security events)
GET /api/dev/keys      -> { "keys": [ { "id", "developerId", "name", "prefix", "scope", "createdAt", "expiresAt", "lastUsedAt", "revokedAt" } ] }   (creating and revoking keys is dashboard only)
```

If a task needs the GitHub token or the Apple key saved or changed, or iPhone signing set up, tell the developer to do it at `/dev/settings`; there is no API path for it by design. `GET /api/dev/me` shows `secrets.signing` (certificate name and expiry) once signing is set up.

## Public and build endpoints (for completeness)

- `GET /api/public/dev/:slug` -> developer name and opted-in apps, details only.
- `GET /api/build/:appId/signing` (certificate, private key, App Store profile and TestFlight link; `HEAD` for the status alone) and `POST /api/build/:appId/testflight/upload` and `/commit` (upload through ourapps) are called by the repository workflow with `Authorization: Bearer <STORE_BUILD_TOKEN>`; see contract.md.
- `GET /api/health` -> `{ "ok": true, ... }`.

## my-app.json, schema 1

Published as a release asset named `my-app.json`:

```json
{
  "schema": 1,
  "id": "poker-night",
  "name": "Poker Night",
  "version": "0.1.1",
  "description": "Texas hold'em for the Thursday table, 3 to 9 players.",
  "icon": "https://api.github.com/repos/owner/name/releases/assets/1",
  "minPlayers": 3,
  "maxPlayers": 9,
  "screenshots": ["https://api.github.com/repos/owner/name/releases/assets/2"],
  "install": {
    "pwa": null,
    "android": { "apk": "https://api.github.com/repos/owner/name/releases/assets/3" },
    "ios": { "bundleId": "com.example.pokernight", "testflight": "https://testflight.apple.com/join/AbCd1234", "devices": ["iphone", "ipad"] }
  }
}
```

`install.pwa`: the https address of the web version, normally the developer's own Cloudflare deploy (`https://<app>-web.<subdomain>.workers.dev/`), opened as is; its build carries a manifest, the Apple home screen tags and a copy of https://ourapps.app/web/install-banner.js (contract.md "Web apps"). A release-asset URL whose asset is named exactly `web.zip` is a bundle the store serves at `https://<linkId>.ourapps.app/`. The install page, `/api/public/links/:id` and `/latest` report the served address, never the GitHub one; the dashboard preview reports null because the preview has no link address. For `web.zip` apps the store injects the same "add to home screen" banner (`/__ourapps/install.js`) into served HTML and, when missing, a standalone manifest, Apple home screen tags and an icon link. Either way the app installs to the home screen with one tap and keeps its camera and microphone grants. When writing a web app for this, request `getUserMedia` from a tap handler and reuse the stream.

Rules: `schema` must be 1; `id` lowercase slug; `name`, `version`, `description` non-empty; `icon` https; `minPlayers` and `maxPlayers` integers of at least 1 with min <= max; `screenshots` optional list of https URLs; optional `screenshotsByPlatform` keys `iphone`, `ipad`, `android`, `web`, `macos`, `windows`, `tvos`, each a list of https URLs (empty lists allowed, unknown keys rejected). `install` requires `pwa`, `android`, `ios` keys, which may be null, and accepts optional `macos`, `windows`, `tvos` targets; at least one target must be non-null. `ios` needs `bundleId` and an https `testflight` URL or null; optional `ios.devices` lists `"iphone"` and/or `"ipad"` for display. Desktop and television declarations follow the specifications above.

## Workflows

Register an app and hand back a share link:

1. `POST /api/dev/apps` with the listing. Store `buildToken` and `app.id` as repository secrets immediately.
2. Make the repository follow contract.md (release workflow, my-app.json, the `my-store-release` trigger). Push a tag.
3. `GET /api/dev/apps/:id/release` until `ok` is true; fix the listed errors.
4. `POST /api/dev/apps/:id/links` with a label. Report `url` and the QR URL.

Diagnose "the page shows no version":

1. `GET /api/dev/me`: if `secrets.github` is false, the developer must save a token.
2. `GET /api/dev/apps/:id/release`: read `errors`.
3. `GET /api/dev/apps/:id/preview`: confirm `release` is not null.

Put an iPhone app on TestFlight:

1. `GET /api/dev/apps/:id/testflight`; while `needs` names a step, tell the developer what it is. The console's TestFlight card walks them through each one, including Apple's New App form.
2. `POST /api/dev/apps/:id/testflight` checks with Apple and, once the app is in App Store Connect, sets up the App Store profile, the friends' beta group and its public link, and asks the repository for the first build.
3. The repository uploads each build through ourapps (contract.md step 4). Follow `stage` with GET (or POST to check with Apple now) and tell the developer plainly what it waits for: the repository's build, Apple's processing or beta review, or the public link in App Store Connect. The install page offers the invitation once `invitation.state` is `open`.

## Prompts

Two prompts the developer can paste into a coding agent are shown on `/dev/agents`, pre-filled for their app: one for an agent inside the app repository (sets up releases to the contract), one for an agent that drives this API (register, check, set up TestFlight, share).

Source code and issues: https://github.com/george-mcintyre/ourapps (public for reading, all rights reserved; outside pull requests are not accepted). Security problems: report privately at https://github.com/george-mcintyre/ourapps/security/advisories/new, never in a public issue.

Copyright Level N Ltd 2026.
