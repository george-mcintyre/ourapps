# ourapps - a private installer for apps you build for friends

Nobody browses here. A developer sends a friend a link or a QR code; the friend taps it and
the app lands on their home screen. No App Store, no Google Play, no accounts for friends.

- iPhone and iPad: Apple's TestFlight. The friend gets Apple's free TestFlight app, opens the
  invitation on the install page and taps Install. ourapps signs each build, the workflow uploads
  it through ourapps, and ourapps sends it to the friends' group and asks for a fresh build before
  the 90-day expiry.
- Android: a direct APK download with a one-time walkthrough of the "allow from this
  source" and Play Protect prompts.
- Web apps: an "add to home screen" walkthrough when the app lists a web version.

## Two faces

- Friends see an App Store style page at `/l/<id>`: icon, tagline, facts strip, screenshots,
  about, what's new, privacy, information, share. Blank fields get generated placeholders so a
  bare listing still looks finished. The page detects iPhone, Android, desktop and in-app
  browsers and shows the right install steps.
- Developers see a console at `/dev`: overview with a setup checklist and stats, apps, share
  links with QR codes, a TestFlight card per iPhone app, settings, an A to Z guide, and an agents page with API keys
  and prompts. Signed-in developers see an owner bar on their own install pages.

## Agents and the API

Everything the console does is an API. Create a key on `/dev/agents` (shown once, `oa_...`),
send it as `Authorization: Bearer`, and read https://ourapps.app/agents.md for every
endpoint. `/dev/agents` also carries two prompts to paste into a coding agent: one sets up an
app repository to the contract, one drives the console (register, check releases, set up
TestFlight, share). `llms.txt` points agents at both documents.

## Security and terms

The guide's Security section (`/dev/guide#security`) explains how credentials, account access
and app files are protected; nothing is recorded about friends. Developers accept the terms and data
statement (`/terms`, version in `shared/src/terms.ts`) at first sign-in and after any change;
the accepted version is shown in the profile, which also offers account deletion.

Credentials are encrypted field by field (AES-256-GCM, key derived per developer from a Worker
secret, authenticated data binding each field to its owner); API keys, build tokens and session
ids are stored as keyed hashes; credential writes need a browser session; API keys have scopes
and expiry; every security event is logged and visible under Settings. Rotation and incident
steps: `SECURITY.md`.

## Layout

| path       | what                                                            |
|------------|-----------------------------------------------------------------|
| `worker/`  | Cloudflare Worker: sign-in, dashboard API, TestFlight, build hooks, artefact proxy |
| `site/`    | Vite + TypeScript site served by the worker                      |
| `shared/`  | my-app.json validation and the terms version                     |
| `site/public/agents.md` | API reference for agents, served at /agents.md            |
| `site/src/freeTiers.ts` | Free-service catalogue: guide section, /small, /free-tiers.md |
| `CONTRACT.md` | what an app repository must implement                         |

## What kinds of app

Native iPhone and Android apps (and anything that compiles to them), and web apps and web games
that the app's workflow deploys to the developer's own free Cloudflare account; the install page
links to them. A `web.zip` release asset is served by ourapps at a per-link address. ourapps never hosts
an app's API or database. Details and limits: `/reference` (source `site/src/pages/reference.ts`);
the diagrams by app type are in `site/public/reference/` (PNG masters, WebP for the site),
generated from the prompts in `docs/diagram-prompts.md`.

## Live check

`npm run smoke` checks the live site; with `OURAPPS_API_KEY` set to a manage key it walks every
endpoint in agents.md on a throwaway app and cleans up (`scripts/smoke.mjs`).

## Who does what

Only a few steps need a human: signing in with GitHub, creating the GitHub token and the Apple
App Store Connect key (saving it sets up iPhone signing: ourapps creates the distribution
certificate; each app's App ID is made when the app is set up for TestFlight), the TestFlight review contact, adding each iPhone app once in App Store
Connect, the Android keystore, creating an API key for the agent, and sending links to people. Everything else (registering the app, the release workflow, releases,
share links, checks) is done by a coding agent with the prompts on `/dev/agents`. The guide's
TL;DR at `/dev/guide#tldr` is the definitive list.

## Add an app

1. Sign in with GitHub at `/dev`.
2. Settings: paste your App Store Connect API key (issuer id, key id, `.p8` contents), your
   Apple team id, and a GitHub fine-grained token with Contents read and write and Actions read on the app's
   repository. They are stored encrypted per account. Saving the Apple key sets up iPhone
   signing (Settings, iPhone signing).
3. Add the app: name, repository `owner/name`, the iPhone bundle ID, and the App Store style
   details (tagline, description, screenshots, privacy summary). Copy the build token and app id
   shown once into the repository secrets `STORE_BUILD_TOKEN` and `STORE_APP_ID`. For iPhone,
   follow the TestFlight card on the app's page; its one manual step is adding the app in App
   Store Connect, and it lists every field to fill in.
4. Make the repository follow `CONTRACT.md`: publish releases with `my-app.json` and
   `CHANGELOG.md` (its sections become the revision history friends see), fetch signing from
   `/api/build/<app>/signing`, upload the iPhone build through ourapps, run on `my-store-release`.
5. Create a share link for the app and send it, or show the QR code.

The in-app guide at `/dev/guide` covers all of this with exact clicks, including how to create
the Apple key and the GitHub token.

## Share

Each share link is `/l/<random id>`. Give it a label (who it is for), an optional expiry,
and revoke it any time. The install page detects iPhone, Android or desktop and shows the
right steps. In-app browsers (Instagram, Facebook, Gmail) cannot install; the page tells
the friend to open it in Safari or Chrome.

Your public page `/<your-slug>` lists only apps you switch on, details only, no install
links, and is marked noindex.

## Limits you must know

- TestFlight: up to 10,000 people per app; Apple's beta review checks the first build of each
  version; builds last 90 days and ourapps asks the repository for a fresh one before then.
- Android does not auto-update. Friends tap Update; an app can offer it by polling
  `/api/public/links/<id>/latest` (see the guide, "Auto-update").
- Install links for the APK are signed and last one hour; the install
  page makes fresh ones every time it loads.

## Develop

```
npm install
npm test                       # shared, worker (vitest with the Cloudflare plugin), site
npm run typecheck
cd worker && npx wrangler d1 migrations apply app-game-store --local
npm run build -w site && npm run dev -w worker      # http://localhost:8787
```

Copy `worker/.dev.vars.example` to `worker/.dev.vars` for local secrets. GitHub sign-in
needs an OAuth App whose callback is `<PUBLIC_ORIGIN>/api/auth/callback`.

## Deploy

The Cloudflare Worker and D1 database are named `app-game-store`
and must keep that name: the Worker's secrets cannot be copied to a new one.

```
cd worker
npx wrangler d1 create app-game-store          # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply app-game-store --remote   # also after adding a migration
npx wrangler secret put LINK_SECRET
npx wrangler secret put MASTER_KEY             # openssl rand -hex 32; rotation in SECURITY.md
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npm run build -w site && npx wrangler deploy
```

`PUBLIC_ORIGIN` in `wrangler.jsonc` is the deployed host (`https://ourapps.app`); sign-in callbacks
and links are built from it.

Source: https://github.com/george-mcintyre/ourapps. The source is public for reading and
review; it is not open source. All rights reserved, see `LICENSE`. Outside contributions are not
accepted (`CONTRIBUTING.md`); report security problems privately (`SECURITY.md`).

Copyright Level N Ltd 2026.
