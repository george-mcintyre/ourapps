# Contract for app repositories

What an app's GitHub repository must publish for friends to install it on phones, computers and Apple TV, or open it in a browser.
The store never looks at your source; it reads one release asset and talks to one workflow.
Served at https://ourapps.app/contract.md; the API reference for agents is at
https://ourapps.app/agents.md. The store dashboard at /dev/agents carries a prompt that sets a
repository up to this contract.

## 1. Publish a release with `my-app.json`

### Desktop package specification

Publish desktop entries only after the actual package has passed download, installation and launch checks. Windows Application Control and other system policies can block unsigned executables after a successful installation; identify the restriction without asking users to change machine policy.

Optional `install.macos` and `install.windows` are null or `{ "packages": [...] }`. Each non-empty package list describes verified release assets:

```json
"macos": { "packages": [{ "url": "https://api.github.com/repos/owner/app/releases/assets/123", "format": "dmg", "architectures": ["arm64", "x64"], "minOsVersion": "14.0", "signing": "signed", "notarization": "notarized" }] },
"windows": { "packages": [{ "url": "https://api.github.com/repos/owner/app/releases/assets/124", "format": "exe", "architectures": ["x64"], "minOsVersion": "10.0.19045", "signing": "unsigned" }] }
```

- Every URL must use HTTPS; release assets use their private release-asset addresses and ourapps' signed-download delivery.
- Architectures must be non-empty, unique and drawn from `arm64` and `x64`; separate architecture-specific installers are separate packages.
- macOS accepts `dmg` only and requires `notarization`, either `notarized` or `not-notarized`; `unsigned` with `notarized` is rejected.
- Windows accepts `exe` only and must omit `notarization`.
- `signing` is `signed` or `unsigned`; unknown enum values are rejected. Minimum system and signing claims must match the verified package.
- Missing or null targets offer no download. Optional `screenshotsByPlatform.macos` and `.windows` use the screenshot fallback rules below.
- Signing and notarization describe the package; operating-system installation checks apply.

### Apple platform specification

Each Apple platform needs its own successful setup, signed export, upload, Apple processing and tester installation checks before delivery is considered verified.

Optional `install.macos.testflight` is `{ "bundleId": "com.example.app.mac", "minOsVersion": "14.0", "architectures": ["arm64", "x64"] }`. The architecture list must be non-empty and unique, using only verified `arm64`/`x64` support. Mac `packages` may be empty only with a valid TestFlight declaration.

Optional `install.tvos` is null or `{ "bundleId": "com.example.app.tv", "minOsVersion": "18.0" }`. Optional `screenshotsByPlatform.tvos` uses the screenshot fallback rules. Player and Board modes belong to the app, not the manifest.

Apple signing, uploads, review progress, invitations and approved versions are stored separately for `ios`, `macos` and `tvos`.

`/api/public/links/:id/latest` includes `apple: { ios, macos, tvos }`. Each key is null or `{ "version": "<available version>", "testflightUrl": "<open invitation>" }`. Non-null requires that platform's build to be available to external testers and its invitation to be open. A GitHub release version is not an approved Apple version. Top-level `testflightVersion` and `testflightUrl` are iOS-only aliases. Direct package updates use `macos` or `windows`, each null or `{ version, packages }`, with signed download URLs.

Platform-specific build addresses:

`release.apple` and `/latest.apple` also include `iosOnMac`, null or `{ version, testflightUrl }`. It describes the iPhone/iPad compatibility version for Macs with Apple silicon, independently of native/Catalyst `macos`. It requires a ready external iOS build and invitation plus Apple's beta-group `iosBuildsAvailableForAppleSiliconMac` flag set to true. A false, unknown or unavailable flag exposes no compatibility invitation. This is not an Intel Mac claim or a Mac signing-profile selection.

```
GET|HEAD /api/build/:app/:platform/signing
POST /api/build/:app/:platform/testflight/upload
POST /api/build/:app/:platform/testflight/commit
```

Existing build addresses are iOS-only aliases. Unknown platforms fail explicitly; they never use iOS credentials as a fallback. A TestFlight declaration offers no install action until its platform's invitation is ready. Direct Mac downloads use Developer ID signing and notarization; Mac TestFlight uses its own distribution signing path.

Set up a platform in a signed-in browser using `POST /api/dev/apps/:id/testflight/:platform` with `{}`. Mac setup defaults to Catalyst (`MAC_CATALYST_APP_STORE`); native Mac setup uses `{ "nativeMac": true }` and `MAC_APP_STORE`. tvOS uses `TVOS_APP_STORE`. Mac setup provisions a separate encrypted `MAC_INSTALLER_DISTRIBUTION` certificate and private key with the saved Apple credentials. Apple may refuse issuance if the account lacks access or reaches its certificate limit; the console reports Apple's error.

Explicit signing responses include `platform`, `profileType`, `upload` and `exportOptions`. Mac also receives `installerCertificate` and `installerPrivateKeyPem`; other platforms never receive these. Import both app and installer signing material into the temporary keychain, install the matching profile, and use the returned manual `app-store-connect` export options. Mac uploads require `.pkg` (`com.apple.pkg`, `MAC_OS`); tvOS requires `.ipa` (`com.apple.ipa`, `TV_OS`). Version and build-number fields match the iOS upload request below. Delete temporary key and response files after import and remove the keychain when the job ends.

Every build publishes a GitHub Release (not a pre-release, not a draft) with these assets:

| asset            | required for | content                                                     |
|------------------|--------------|-------------------------------------------------------------|
| `my-app.json`    | always       | schema 1 manifest (shape and rules in agents.md)             |
| `icon.png`, `screenshot-*.png` | recommended | referenced from my-app.json `icon`, `screenshots` and `screenshotsByPlatform` |
| `CHANGELOG.md`   | recommended  | Keep a Changelog file; the version's section is the release notes |
| `<app>.apk`      | Android      | signed APK                                                  |

Create the release as a draft, upload every asset with `my-app.json` last, then publish it
(`gh release edit <tag> --draft=false`). A release that goes public first is "latest" while its
files are still uploading, and install pages fail until `my-app.json` arrives. Asset ids, and so
the asset API URLs, stay the same when a draft is published. Read a draft's asset ids by release
id (`GET /repos/<owner>/<repo>/releases/<id>/assets`); the by-tag endpoint does not return
drafts.

The store resolves `GET /repos/<owner>/<repo>/releases/latest`, takes the asset named
`my-app.json`, and follows the URLs inside it. Those URLs are the release-asset API URLs,
for example `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`, which the
store fetches with the developer's GitHub token. The store rewrites them to short-lived signed
links before the phone sees them, so private repositories work and nothing public is guessable.

Repositories that publish elsewhere can set a direct `my-app.json` URL on the app in the
dashboard instead; the artefact URLs then need to be HTTPS and unguessable.

### Release notes become the revision history

The install page shows a revision history built from the repository's releases: one entry per
published (non-draft, non-pre-release) release, labelled with the version found in the release
name or tag, dated from the release, and showing the commit the tag points at.

Notes for each version come, in order of preference, from:

1. The `CHANGELOG.md` asset on the latest release, in Keep a Changelog form: a
   `## [1.2.0] - 2026-10-17` (or `## 1.2.0`, `## v1.2.0`) section per version, newest first.
   `### Added`, `### Changed`, `### Fixed` subheadings become labels; bullets stay bullets.
   An `[Unreleased]` section is ignored. One file covers every version.
2. The release body.
3. The commit message of the tagged commit.

Keep `CHANGELOG.md` at the repository root, have the workflow upload it as a release asset
and use the version's section as the release body, and fail the release when the section is
missing. Write for the people who use the app. GitHub's generated "by @user in ..." and
"Full Changelog" lines are stripped; links to GitHub appear only when the repository is
public. A release named like "Poker Night 0.7.2 (build 53)" shows only the version; names that say
more ("First table night") show as a title. The "What's new" section shows the latest
release's notes and the "Updated" date is the release date; the dashboard's What's new field
and listing edit date are used only when no release notes exist.

### Screenshots per version

`screenshots` is the general list. The optional `screenshotsByPlatform` object gives a version
its own list, with keys `iphone`, `ipad`, `android` and `web` (each a list of https URLs; an
empty list counts as not provided; unknown keys fail validation). Screenshots keep their own
proportions on the page: portrait for phones, usually 3:4 for iPad, landscape for web.

```json
"screenshots": ["https://api.github.com/repos/you/app/releases/assets/11"],
"screenshotsByPlatform": {
  "ipad": ["https://api.github.com/repos/you/app/releases/assets/12"],
  "web": ["https://api.github.com/repos/you/app/releases/assets/13"]
}
```

For each version (iPhone, iPad, Android, Web) the install page shows the first list that exists: that version's list in the dashboard, that version's list in my-app.json, the general list in the dashboard, the general list in my-app.json, then the closest other version's list (so a single set covers every version), and generated previews in the version's shape only when no screenshots exist at all.
On a phone or tablet the page shows the matching version; on a computer it shows a tab per version.

## 2. iPhone and iPad through TestFlight

Friends install iPhone and iPad apps through Apple's TestFlight app from a public invitation
link, with nothing to change in Settings. ourapps holds the signing material, uploads go through
ourapps, and ourapps puts each processed build in the friends' group and sends it for Apple's beta
review (the first build of each version). A TestFlight build lasts 90 days; ourapps asks the
repository for a fresh build before then (step 5), so friends keep the app indefinitely.

Once per app the developer adds it in App Store Connect; Apple offers no API for this. The
TestFlight card on the app's page in ourapps lists every field of Apple's New App form, notices
when the app is there, makes the App Store profile, the beta group and its public link, and sends
the repository `my-store-release` (step 5) for the first build.

The public link lets anyone with it join; nobody is invited one by one. Apple's page for the link
refuses testers until a build in the group has passed beta review, so the install page offers
the invitation only once ourapps has read that page and found it open; until then friends on
iPhone see "coming soon", with the web version when there is one.

A universal app needs nothing extra: build one `.ipa` with `TARGETED_DEVICE_FAMILY` set to `1,2`.
Optionally say which devices the build targets with `install.ios.devices`, any of `"iphone"` and
`"ipad"` (for example `["iphone", "ipad"]`). It is display only: the install page says "for iPhone
and iPad" or "for iPhone", and warns on the device a build was not made for, but never blocks an
install. Absent, the page makes no claim.

## 3. Get the certificate, key and profile

The store holds the developer's Apple Distribution certificate, its private key and each app's
App Store profile; the repository needs no Apple secrets. One call returns them:

```
GET https://ourapps.app/api/build/<STORE_APP_ID>/signing
Authorization: Bearer $STORE_BUILD_TOKEN
```

Response: `{ "certificate": { "id", "name", "serialNumber", "expirationDate", "base64" },
"privateKeyPem", "teamId", "storeProfile": { "profileName", "profileId", "uuid", "profileBase64" },
"testflight": { "url" } }`. `certificate.base64` is the DER certificate, `privateKeyPem` a PKCS #8
RSA key and `storeProfile` the app's App Store profile; `testflight.url` is null until Apple has
made the invitation link. 404 until iPhone signing and TestFlight are set up for the app; `HEAD`
gives the status without the key, so build for iPhone only when it is 200.

On the macOS runner:

```bash
curl -sSf -H "Authorization: Bearer $STORE_BUILD_TOKEN" \
  "https://ourapps.app/api/build/$STORE_APP_ID/signing" > "$RUNNER_TEMP/signing.json"
KC="$RUNNER_TEMP/build.keychain-db"
security create-keychain -p "" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "" "$KC"
jq -r .privateKeyPem "$RUNNER_TEMP/signing.json" > "$RUNNER_TEMP/key.pem"
jq -r .certificate.base64 "$RUNNER_TEMP/signing.json" | base64 -d > "$RUNNER_TEMP/cert.cer"
security import "$RUNNER_TEMP/key.pem" -k "$KC" -A
security import "$RUNNER_TEMP/cert.cer" -k "$KC"
rm "$RUNNER_TEMP/key.pem"
security set-key-partition-list -S apple-tool:,apple: -s -k "" "$KC" >/dev/null
security list-keychain -d user -s "$KC" login.keychain-db
uuid=$(jq -r .storeProfile.uuid "$RUNNER_TEMP/signing.json")
mkdir -p ~/Library/MobileDevice/Provisioning\ Profiles
jq -r .storeProfile.profileBase64 "$RUNNER_TEMP/signing.json" | base64 -d \
  > ~/Library/MobileDevice/Provisioning\ Profiles/"$uuid".mobileprovision
```

Build with manual signing: identity `Apple Distribution` and the profile named
`.storeProfile.profileName`, set on the app target only (in the project, for example XcodeGen's
`project.yml`). Passed as `xcodebuild` overrides they also reach Swift package resource bundles,
which then fail with "requires a development team". Export with `method` `app-store-connect`,
`signingStyle` `manual`, `teamID` `.teamId` and `provisioningProfiles` mapping the bundle ID to
that profile name. Set `ITSAppUsesNonExemptEncryption` to `false` in Info.plist. ourapps also gives Apple that
answer for any build that arrives without it, so no build waits for export compliance; distribute
through ourapps only apps that use no non-exempt encryption (the terms, section 5). `CFBundleVersion` must be higher on every upload.
Delete the keychain and `signing.json` when the job ends, also on failure.

## 4. Upload through ourapps

ourapps reserves the upload at Apple and returns where to send the bytes; the workflow sends
them straight to Apple, then tells ourapps the file's MD5. Any runner can do this step.

```bash
IPA=app.ipa
SIZE=$(wc -c < "$IPA" | tr -d ' ')
MD5=$(openssl dgst -md5 "$IPA" | awk '{print $NF}')
API="https://ourapps.app/api/build/$STORE_APP_ID/testflight"
jq -n --arg v "$VERSION" --arg b "$BUILD" --argjson s "$SIZE" --arg n "$NOTES" \
  '{version: $v, buildNumber: $b, fileName: "app.ipa", fileSize: $s, whatsNew: $n}' |
  curl -sSf -X POST -H "Authorization: Bearer $STORE_BUILD_TOKEN" -H "Content-Type: application/json" \
    --data-binary @- "$API/upload" > upload.json
jq -c '.operations[]' upload.json | while read -r op; do
  args=(); while IFS= read -r h; do args+=(-H "$h"); done < <(jq -r '.requestHeaders[]? | "\(.name): \(.value)"' <<<"$op")
  tail -c +$(( $(jq -r .offset <<<"$op") + 1 )) "$IPA" | head -c "$(jq -r .length <<<"$op")" |
    curl -sSf -X "$(jq -r .method <<<"$op")" "${args[@]}" --data-binary @- "$(jq -r .url <<<"$op")"
done
jq -n --arg f "$(jq -r .uploadFileId upload.json)" --arg m "$MD5" '{uploadFileId: $f, md5: $m}' |
  curl -sSf -X POST -H "Authorization: Bearer $STORE_BUILD_TOKEN" -H "Content-Type: application/json" \
    --data-binary @- "$API/commit"
```

`whatsNew` is the version's release notes; TestFlight shows them to friends. ourapps checks
Apple every ten minutes: once the build is processed, it answers export compliance where the
build has no answer, adds the build to the friends' group, sends it for beta review, makes it available to the group
when Apple approves it (App Store Connect's "Notify Testers"), and reads the invitation page. The
app's page in ourapps shows each step and what it waits for.

## 5. Releases and fresh builds

The console reads workflow runs using Actions read permission. iOS uses `release.yml`; Mac and Apple TV use only `apple-testflight.yml` with `run-name: Apple TestFlight ${{ inputs.platform }} ${{ inputs.version }} (${{ inputs.build }})`. That title identifies the platform; app/request association remains approximate. A successful workflow with no matching platform/version/build upload is shown as Finished without upload. Running progress estimates use successful same-platform workflow/job timings.

Mac/Apple TV requests require Actions write and Contents read. They dispatch `apple-testflight.yml` on the repository's default branch with `platform`, validated manifest `version`, reserved numeric `build`, and `upload: "true"`. Build numbers are atomically reserved per app/platform/version, above known Apple and local builds; failed dispatches consume reservations. Coordinate all uploaders through this allocation path: uploads made elsewhere after Apple's lookup are outside that lock, and Apple can reject a duplicate build number. Missing workflow or permissions are explicit errors, never an iOS fallback. Private GitHub release-asset redirects are followed only to approved GitHub asset hosts without forwarding credentials.

The release carries `my-app.json` with `install.ios` set to
`{ "bundleId": "<bundle id>", "testflight": "<.testflight.url from step 3, or https://testflight.apple.com when null>" }`;
ourapps shows its own invitation link in its place. The `.ipa` is not a release asset.

ourapps asks the repository for a build when TestFlight is set up for the app, when the
developer asks for one on the app's TestFlight card, and two weeks before the newest TestFlight
build expires:

```
POST https://api.github.com/repos/<owner>/<repo>/dispatches
{ "event_type": "my-store-release", "client_payload": { "app": "<STORE_APP_ID>", "reason": "<reason>" } }
```

`reason` is `testflight-set-up`, `requested` or `testflight-expiry`.

Handle it like a manual release of the current version with a higher build number:

```yaml
on:
  repository_dispatch:
    types: [my-store-release]
```

## Secrets the app repository needs

| secret               | from                                                    |
|----------------------|---------------------------------------------------------|
| `STORE_BUILD_TOKEN`  | shown once when the app is created in the dashboard     |
| `STORE_APP_ID`       | the app's id in the dashboard                           |
| Android keystore     | your own                                                |

`STORE_BUILD_TOKEN` is per app. Rotate it from the app's page in the dashboard.

## Optional: web apps

`install.pwa` is the https address the install page opens. Put the built site on your own free
Cloudflare account: Cloudflare serves plain files without a request limit or charge, your
workflow deploys them, and ourapps never sees your Cloudflare token.

### On your own Cloudflare account

Once per Cloudflare account, in the dashboard:

1. Create a free account at https://dash.cloudflare.com, or use one that runs nothing else you
   care about: Cloudflare cannot limit the token to one Worker, so it can replace any Worker on
   the account.
2. Workers & Pages: choose a `workers.dev` subdomain. Sites are served at
   `https://<worker name>.<subdomain>.workers.dev`.
3. My Profile, API Tokens, Create Token, template "Edit Cloudflare Workers". Account
   Resources: your account; Zone Resources: all zones from that account. Copy the token; it is
   shown once.
4. Copy the Account ID (Workers & Pages, Account details).

Once per repository: Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

`wrangler.jsonc` in the repository describes a Worker with files only, under a name no other
Worker on the account uses:

```jsonc
{
  "name": "<app>-web",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./web/dist", "not_found_handling": "single-page-application" },
  "workers_dev": true,
  "preview_urls": false
}
```

The release workflow builds the site, deploys it and keeps the address for `install.pwa`:

```yaml
- name: Deploy the web app
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: |
    npx wrangler@4 deploy | tee "$RUNNER_TEMP/deploy.log"
    echo "WEB_URL=$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$RUNNER_TEMP/deploy.log" | head -1)/" >> "$GITHUB_ENV"
```

Each deploy replaces the site in place, so the address stays the same from release to release.
Fail the release when the deploy fails or `WEB_URL` is empty.

In the build output:

- `manifest.webmanifest` (name, `start_url` and `scope` of `./`, `display: "standalone"`, 192
  and 512 pixel icons) and the `apple-mobile-web-app-capable`, `apple-mobile-web-app-title` and
  `apple-touch-icon` tags, so the app runs from the home screen.
- A copy of https://ourapps.app/web/install-banner.js, fetched at build time and loaded with
  `<script src="install-banner.js" defer></script>`: the "add to home screen" banner the install
  page tells friends to expect. Copy it; do not link to ourapps.
- `_headers` at the root: `X-Robots-Tag: noindex` for `/*`, and for threaded Unity or Godot
  builds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- No pre-compressed files. Cloudflare compresses `.html`, `.js`, `.css` and `.wasm` itself and
  does not honour `Content-Encoding` from `_headers`, so a `.br` or `.gz` file reaches the browser
  still compressed. Unity: Compression Format "Disabled", or Brotli with "Decompression Fallback".

Free plan limits: 20,000 files per deploy, 25 MiB per file, 100 Workers per account.

The address is public: anyone who has it can open the app, and revoking a share link does not
stop them. Keep private data behind the app's own sign-in, and allow the address in your API's
CORS. Storage, service workers and permissions belong to that address.

An app that already runs its own Cloudflare Worker can serve the build from it instead, with an
`assets` block in that Worker's settings, which puts the web app and its server on one address.

### Served by the store from `web.zip`

A release-asset URL whose asset is named exactly `web.zip` is a bundle of the built site that the store copies and serves at `https://<linkId>.ourapps.app/`,
one origin per share link, nothing from the console shared with it. On the first request after a
release the store fetches the zip, unpacks it once into its storage and serves single files from
there; the release is re-checked at most once a minute. These requests count against ourapps'
shared allowance; the developer's own Cloudflare account has no such limit. When the latest
release has no `web.zip` and `install.pwa` names an address elsewhere, the link addresses
redirect there, so home screen icons made from them open the app.

- Limits: zip at most 25 MB, at most 32 MB unpacked, any file at most 24 MB, at most 2,000
  files, at most 8 MB of compressed (deflated) content. Build it uncompressed:
  `zip -0 -r web.zip .` (text is brotli-compressed on the way to the browser anyway).
- Layout: `index.html` at the zip root or inside one top-level folder. Relative (`./`) or
  root (`/`) paths both work because the app is served at the root of its own origin.
  `manifest.webmanifest` with `start_url` and `scope` of `./`; service worker registered
  with a relative path. Unknown paths without an extension get `index.html`.
- Pre-compressed files (`.wasm.br`, `.js.gz`, `.data.br` and similar) are sent with
  `Content-Encoding` and the inner content type, as Unity and Godot expect.
- An optional `_headers` file (Cloudflare Pages format) may set
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`,
  `Cross-Origin-Resource-Policy`, `Permissions-Policy`, `Content-Security-Policy` and
  `Cache-Control`; anything else is ignored. Needed for threaded Unity and Godot builds.
- Storage, service workers and permissions belong to each link's origin. Allow the link
  origins (`^https://[0-9a-f]{16,64}\.ourapps\.app$`) in your API's CORS and use token
  authentication, not cookies.

## Optional: in-app updates

TestFlight updates iPhone apps itself. Android apps do not update by themselves; an app can poll
`GET https://ourapps.app/api/public/links/<linkId>/latest` (any active share link; a dedicated
"In-app updates" link is the convention), compare `version` with its own, and open
`android.apkUrl` (or, on iPhone, compare with `testflightVersion`, the version TestFlight has, and open `testflightUrl`). The links inside expire after one hour. Bump
`versionCode` / `CFBundleVersion` on every release and keep the Android signing key stable.

## Limits to design around

- TestFlight: up to 10,000 people per app through the public link; each build lasts 90 days
  (ourapps asks for a fresh one before then); Apple reviews the first build of each version.
- The Apple Distribution certificate lasts a year; replace it under Settings before it expires.
  ourapps makes each app's App Store profile again with it, and the next build uses it.
- macOS GitHub Actions minutes cost ten times Linux minutes against the free allowance;
  keep the iOS job lean or document a local Xcode signing path.

Copyright Level N Ltd 2026.
