# Gotchas

- Default `Python-urllib` requests to ourapps can receive Cloudflare HTTP403/error1010 before Worker authentication. A descriptive application User-Agent reaches the expected unauthenticated401 response; keep redirect/credential protections intact. Controlled curl/Python probes and Cloudflare's Error1010 documentation confirm this behavior.

- Approved TestFlight versions refresh through `refreshApprovedVersions` on public page and update reads, at most once a minute while builds are pending. Install pages re-read on return to the foreground and every visible minute; `installPage` owns listener cleanup.

- `@cloudflare/vitest-pool-workers` is deprecated; this repo uses `@cloudflare/vitest-plugin`
  with `cloudflareTest()` and `readD1Migrations` in `worker/vitest.config.ts`. Tests import
  `env` from `cloudflare:workers` and `applyD1Migrations` from `cloudflare:test`.
- Handlers take `deps` (`fetch`, `now`, `sleep`) so tests stub Apple, GitHub and time
  without network; see `worker/test/helpers.ts`.
- The session cookie only works because the site and `/api` share one origin. Do not move
  the site to another host (GitHub Pages) without switching to bearer tokens.
- Apple profiles cannot be edited: the worker deletes and recreates the App Store profile with
  the same name when it lacks the current certificate.
- Apple JSON Web Tokens must expire within 20 minutes of `iat` (the worker uses 10).
- Installs do not work inside most apps' web views (Instagram, Facebook, Gmail). The install
  page shows an "open in Safari" instruction; WhatsApp is the exception.
- Developer slugs may not collide with `api`, `dl`, `dev`, `l` (see `RESERVED_SLUGS`).
- `wrangler` is not installed globally; use `npx wrangler` inside `worker/`.
- GitHub Pages on a private repo needs a paid plan; this repo is public for that reason
  even though Pages is no longer used.
- Cookie sessions refuse writes whose `Origin` differs from `PUBLIC_ORIGIN` (localhost origins
  allowed when `PUBLIC_ORIGIN` is localhost). API keys (`oa_...`) skip that check and cannot
  create or revoke keys.
- Grid children need `min-width: 0` or a long URL widens the page on phones; `style.css`
  sets it for `.stack`, `.grid-2`, `.grid-3` and the card layouts. Keep that in mind for new
  grids.
- Desktop Chrome will not open a window narrower than about 500 px, so headless screenshots
  at phone widths lie; use `npx playwright screenshot --channel chrome --viewport-size=390,844`.
- `site/public/contract.md` is generated (gitignored); edit `CONTRACT.md` at the root.
- Credentials: one ciphertext per field (`worker/src/secrets.ts`, format 2 with `kid`). Token
  hashes carry the `h2:` prefix and are peppered from `MASTER_KEY`; verification also tries
  `MASTER_KEY_PREVIOUS` and plain SHA-256, rewriting on match. Never compare a token against a
  stored hash without going through `hashMatches`.
- `PUT /api/dev/secrets` and key management are session-only; tests that need credentials must
  sign in with a cookie, not an API key.
- Per-link app hosts are detected by host suffix in `handle()` before any console routing;
  they never see the session cookie logic, and `/api/*` and `/dl/*` are 404 there on purpose.
  Local `wrangler dev` cannot exercise wildcard hosts; tests cover it with synthetic Requests.
- Never inflate a web.zip per request: the free plan's 10 ms CPU budget fails on bundles of a
  few MB (Cloudflare error 1102). `webapp.ts` unpacks once per release tag into ~2 MB packs in
  the `WEBAPP_FILES` KV namespace (a handful of writes; the free plan allows 1,000 writes a day
  for the whole account) and caches single files at the edge; the current tag is cached 60 s.
  Deflated content is capped at 8 MB for the same CPU reason; bundles should use `zip -0`.
- Session and OAuth state cookies are `__Host-` prefixed on https so `<link>.ourapps.app`
  pages cannot toss cookies to the console; plain names only on http://localhost.
- Cache API keys use `${PUBLIC_ORIGIN}/__cache/...`; arbitrary hostnames are not documented to
  cache.
- Never rename the Cloudflare Worker (`"name": "app-game-store"` in `worker/wrangler.jsonc`):
  a new name deploys a new Worker without the secrets, and `MASTER_KEY` cannot be read back, so
  every stored credential would become undecryptable. The D1 database name stays too. Users only
  ever see `ourapps.app`.
- Never create a new GitHub repository named `app-game-store` under the account; it would break
  GitHub's forwarding from the old name.
- Client-facing error text must be thrown as `HttpError`; any other error becomes a generic 500
  with a reference (`errorResponse` in `worker/src/index.ts`), and public web app pages show a
  fixed sentence. Plain `Error` messages can name private repositories, so never return them.
  CodeQL `js/stack-trace-exposure` still flags the HttpError path; alert 1 was dismissed as a
  false positive for that reason.
- Accepted risks, decided by the owner on 2026-10-18; do not "fix" them unasked: (1) anyone can
  use up the free plan's 100,000 requests a day, stopping installs until the next day; (2) open
  sign-up lets any GitHub user serve files through ourapps.app, which could get the domain
  flagged by Safe Browsing (deferred until the owner has investigated options).
- iPads use the same path as iPhones (`platform` "ios"); wording comes from `appleDeviceName`.
- `wrangler dev` presents requests as coming from the route's host (ourapps.app), so with
  `PUBLIC_ORIGIN=http://localhost:8787` every console save was refused as cross-site locally.
  `npm run dev -w worker` passes `--local-upstream localhost:8787`; running plain `wrangler dev`
  reproduces the refusal. Production is unaffected.
