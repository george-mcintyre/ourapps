// Short-lived signed links for artefacts served through /dl/<token>.
import { fromBase64url, toBase64url } from "./crypto.js";

const encoder = new TextEncoder();

export const LINK_TTL_SECONDS = 60 * 60;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface LinkPayload {
  url: string;
  kind: "apk" | "icon" | "dmg" | "exe";
  // Developer whose GitHub token may be used to fetch the url.
  dev: string;
  exp: number;
}

export async function signLink(secret: string, payload: LinkPayload): Promise<string> {
  const body = toBase64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64url(new Uint8Array(sig))}`;
}

export async function verifyLink(secret: string, token: string, now: Date): Promise<LinkPayload | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: LinkPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (typeof payload.url !== "string" || typeof payload.exp !== "number" || typeof payload.dev !== "string") return null;
  if (!["apk", "icon", "dmg", "exe"].includes(payload.kind)) return null;
  if (payload.exp * 1000 < now.getTime()) return null;
  return payload;
}

export function linkExpiry(now: Date): number {
  return Math.floor(now.getTime() / 1000) + LINK_TTL_SECONDS;
}
