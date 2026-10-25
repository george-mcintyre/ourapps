import { TERMS_VERSION } from "@my/store-shared";
import { finishLogin, logout, logoutEverywhere, oauthConfigured, requireDeveloper, requireTerms, startLogin } from "./auth.js";
import { defaultDeps, type Deps, type Env } from "./env.js";
import { randomId } from "./crypto.js";
import { HttpError, json } from "./http.js";
import { buildSigning, buildTestflight } from "./routes/build.js";
import { tickTestflight } from "./testflight.js";
import * as dev from "./routes/dev.js";
import { devPage, linkLatest, linkPage, linkQr, serveArtefact } from "./routes/public.js";
import { serveWebApp, webAppLinkId } from "./webapp.js";

// Sent on every response so browsers and scanners see a locked-down site.
export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

// HttpError messages are written for clients; anything else may carry internal detail, so it is
// logged and the client gets a reference only.
export function errorResponse(request: Request, err: unknown): Response {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(err.message);
    return json({ error: err.message }, err.status);
  }
  const ref = request.headers.get("cf-ray") ?? randomId(6);
  console.error(`unexpected error ${ref}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return json({ error: `something went wrong (reference ${ref})` }, 500);
}

export async function handle(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  // Per-link app hosts get the bundle and nothing else; they set their own headers.
  const webLink = webAppLinkId(request, env);
  if (webLink) return serveWebApp(request, env, deps, webLink);
  let res: Response;
  try {
    res = await route(request, env, deps);
  } catch (err) {
    res = errorResponse(request, err);
  }
  res = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

async function route(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const m = request.method;

  if (parts[0] === "dl" && parts.length === 2 && m === "GET") return serveArtefact(env, deps, parts[1]);
  if (parts[0] !== "api") {
    const verification = env.GOOGLE_SITE_VERIFICATION;
    if (verification && parts.length === 1 && parts[0] === verification && m === "GET") {
      return new Response(`google-site-verification: ${verification}`, { headers: { "Content-Type": "text/html" } });
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    throw new HttpError(404, "not found");
  }
  const p = parts.slice(1);

  if (p[0] === "health" && m === "GET") return json({ ok: true, oauth: oauthConfigured(env), links: Boolean(env.LINK_SECRET), secrets: Boolean(env.MASTER_KEY) });

  if (p[0] === "auth") {
    if (p[1] === "github" && m === "GET") return startLogin(env);
    if (p[1] === "callback" && m === "GET") return finishLogin(request, env, deps);
    if (p[1] === "logout" && m === "POST") return logout(request, env, deps);
    if (p[1] === "logout-everywhere" && m === "POST") return logoutEverywhere(request, env, deps, await requireDeveloper(request, env, deps));
  }

  if (p[0] === "public") {
    if (p[1] === "dev" && p.length === 3 && m === "GET") return devPage(env, p[2]);
    if (p[1] === "links" && p.length === 3 && m === "GET") return linkPage(env, deps, p[2]);
    if (p[1] === "links" && p.length === 4 && p[3] === "qr.svg" && m === "GET") return linkQr(env, deps, p[2]);
    if (p[1] === "links" && p.length === 4 && p[3] === "latest" && m === "GET") return linkLatest(env, deps, p[2]);
  }

  if (p[0] === "build" && p.length === 3 && p[2] === "signing" && (m === "GET" || m === "HEAD")) return buildSigning(request, env, p[1]);
  if (p[0] === "build" && p.length === 4 && p[3] === "signing" && (m === "GET" || m === "HEAD")) return buildSigning(request, env, p[1], p[2]);
  if (p[0] === "build" && p.length === 5 && p[3] === "testflight" && (p[4] === "upload" || p[4] === "commit" || p[4] === "reserve-build") && m === "POST") return buildTestflight(request, env, deps, p[1], p[4], p[2]);
  if (p[0] === "build" && p.length === 4 && p[2] === "testflight" && (p[3] === "upload" || p[3] === "commit") && m === "POST") return buildTestflight(request, env, deps, p[1], p[3]);

  if (p[0] === "dev") {
    const me = await requireDeveloper(request, env, deps);
    if (p[1] === "me" && m === "GET") return dev.me(env, me);
    if (p[1] === "terms" && m === "POST") return dev.acceptTerms(request, env, deps, me);
    requireTerms(me, TERMS_VERSION);
    if (p[1] === "me" && m === "DELETE") return dev.deleteAccount(request, env, me);
    if (p[1] === "me" && m === "PUT") return dev.updateMe(request, env, me);
    if (p[1] === "secrets" && m === "PUT") return dev.updateSecrets(request, env, deps, me);
    if (p[1] === "signing" && p.length === 2 && m === "POST") return dev.setUpSigning(request, env, deps, me);
    if (p[1] === "review-contact" && p.length === 2 && m === "PUT") return dev.updateReviewContact(request, env, me);
    if (p[1] === "apps") {
      if (p.length === 2 && m === "GET") return dev.listApps(env, deps, me);
      if (p.length === 2 && m === "POST") return dev.createApp(request, env, deps, me);
      if (p.length === 3 && m === "GET") return dev.getApp(env, me, p[2]);
      if (p.length === 3 && m === "PUT") return dev.updateApp(request, env, deps, me, p[2]);
      if (p.length === 3 && m === "DELETE") return dev.deleteApp(request, env, deps, me, p[2]);
      if (p.length === 4 && p[3] === "build-token" && m === "POST") return dev.rotateBuildToken(request, env, deps, me, p[2]);
      if (p.length === 4 && p[3] === "release" && m === "GET") return dev.releaseStatus(env, deps, me, p[2]);
      if (p.length === 4 && p[3] === "preview" && m === "GET") return dev.previewApp(env, deps, me, p[2]);
      if (p.length === 4 && p[3] === "links" && m === "POST") return dev.createLink(request, env, deps, me, p[2]);
      if (p.length === 4 && p[3] === "testflight" && m === "GET") return dev.testflightStatus(env, me, p[2], "ios", deps);
      if (p.length === 4 && p[3] === "testflight" && m === "POST") return dev.setUpAppTestflight(request, env, deps, me, p[2]);
      if (p.length === 5 && p[3] === "testflight" && p[4] === "build" && m === "POST") return dev.requestAppBuild(env, deps, me, p[2]);
      if (p.length === 5 && p[3] === "testflight" && m === "GET") return dev.testflightStatus(env, me, p[2], p[4], deps);
      if (p.length === 5 && p[3] === "testflight" && m === "POST") return dev.setUpAppTestflight(request, env, deps, me, p[2], p[4]);
      if (p.length === 6 && p[3] === "testflight" && p[5] === "build" && m === "POST") return dev.requestAppBuild(env, deps, me, p[2], p[4]);
    }
    if (p[1] === "links" && p.length === 4 && p[3] === "revoke" && m === "POST") return dev.revokeLink(env, deps, me, p[2], false);
    if (p[1] === "links" && p.length === 3 && m === "DELETE") return dev.revokeLink(env, deps, me, p[2], true);
    if (p[1] === "links" && p.length === 3 && m === "PUT") return dev.renameLink(request, env, me, p[2]);
    if (p[1] === "keys") {
      if (p.length === 2 && m === "GET") return dev.listKeys(env, me);
      if (p.length === 2 && m === "POST") return dev.createKey(request, env, deps, me);
      if (p.length === 3 && p[2] === "revoke-all" && m === "POST") return dev.revokeAllKeys(request, env, deps, me);
      if (p.length === 3 && m === "DELETE") return dev.revokeKey(request, env, deps, me, p[2]);
    }
    if (p[1] === "audit" && p.length === 2 && m === "GET") return dev.auditLog(env, me);
  }
  throw new HttpError(404, "not found");
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  // Every ten minutes: TestFlight builds into the friends' group and fresh builds before expiry.
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(tickTestflight(env, defaultDeps)),
} satisfies ExportedHandler<Env>;
