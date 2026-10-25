// Read and write a developer's encrypted credentials, one ciphertext per field.
import { SECRET_FORMAT, keyId, openField, openLegacyBlob, sealField, type Sealed } from "./crypto.js";
import { Db, type DeveloperSecrets } from "./db.js";
import type { Env } from "./env.js";
import { HttpError } from "./http.js";

export const SECRET_FIELDS = ["appleIssuerId", "appleKeyId", "applePrivateKey", "appleTeamId", "githubToken", "signingKey", "installerSigningKey"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];
// The fields a developer types in Settings; signingKey is only written by signing setup.
export const EDITABLE_SECRET_FIELDS = ["appleIssuerId", "appleKeyId", "applePrivateKey", "appleTeamId", "githubToken"] as const satisfies readonly SecretField[];

interface Envelope {
  v: number;
  kid: string;
  fields: Partial<Record<SecretField, Sealed>>;
  savedAt: Partial<Record<SecretField, string>>;
}

function masterKeys(env: Env): { current: string; previous: string | null } {
  if (!env.MASTER_KEY) throw new HttpError(503, "MASTER_KEY is not configured");
  return { current: env.MASTER_KEY, previous: env.MASTER_KEY_PREVIOUS || null };
}

// Pick the master key that produced a ciphertext; null when neither configured key matches.
async function keyFor(env: Env, kid: string): Promise<string | null> {
  const { current, previous } = masterKeys(env);
  if ((await keyId(current)) === kid) return current;
  if (previous && (await keyId(previous)) === kid) return previous;
  return null;
}

async function parse(env: Env, developerId: string, blob: string): Promise<{ envelope: Envelope; stale: boolean }> {
  const { current, previous } = masterKeys(env);
  if (blob.startsWith("{")) {
    const envelope = JSON.parse(blob) as Envelope;
    if (envelope.v !== SECRET_FORMAT) throw new HttpError(500, `unknown credential format ${envelope.v}`);
    const stale = (await keyId(current)) !== envelope.kid;
    return { envelope, stale };
  }
  // Format 1: one AES-GCM blob holding the whole JSON object.
  let legacy: DeveloperSecrets | null = null;
  for (const k of [current, previous]) {
    if (!k) continue;
    try {
      legacy = await openLegacyBlob<DeveloperSecrets>(k, developerId, blob);
      break;
    } catch {
      legacy = null;
    }
  }
  if (!legacy) throw new HttpError(500, "stored credentials cannot be decrypted with the configured master keys");
  const envelope: Envelope = { v: SECRET_FORMAT, kid: "legacy", fields: {}, savedAt: legacy.savedAt ?? {} };
  for (const f of SECRET_FIELDS) if (legacy[f]) envelope.fields[f] = await sealField(current, developerId, f, legacy[f]!);
  return { envelope, stale: true };
}

// Decrypt only the requested fields; a stale envelope is rewrapped under the current key.
export async function loadSecrets(env: Env, developerId: string, only?: readonly SecretField[]): Promise<DeveloperSecrets> {
  const db = Db.from(env);
  const blob = await db.secretsBlob(developerId);
  if (!blob) return {};
  const { envelope, stale } = await parse(env, developerId, blob);
  const key = envelope.kid === "legacy" ? masterKeys(env).current : await keyFor(env, envelope.kid);
  if (!key) throw new HttpError(500, "stored credentials were sealed with a master key that is no longer configured");
  const out: DeveloperSecrets = { savedAt: envelope.savedAt };
  const wanted = only ?? SECRET_FIELDS;
  for (const f of wanted) {
    const sealed = envelope.fields[f];
    if (sealed) out[f] = await openField(key, developerId, f, sealed);
  }
  if (stale) await rewrap(env, developerId, envelope, key);
  return out;
}

// Presence and dates without decrypting anything; a legacy blob is upgraded on the way.
export async function secretsSummary(env: Env, developerId: string): Promise<DeveloperSecrets> {
  const blob = await Db.from(env).secretsBlob(developerId);
  if (!blob) return {};
  if (!blob.startsWith("{")) {
    const full = await loadSecrets(env, developerId);
    const out: DeveloperSecrets = { savedAt: full.savedAt };
    for (const f of SECRET_FIELDS) if (full[f]) out[f] = "set";
    return out;
  }
  const envelope = JSON.parse(blob) as Envelope;
  const out: DeveloperSecrets = { savedAt: envelope.savedAt };
  for (const f of SECRET_FIELDS) if (envelope.fields[f]) out[f] = "set";
  return out;
}

async function rewrap(env: Env, developerId: string, envelope: Envelope, oldKey: string): Promise<void> {
  const { current } = masterKeys(env);
  const fields: Envelope["fields"] = {};
  for (const f of SECRET_FIELDS) {
    const sealed = envelope.fields[f];
    if (!sealed) continue;
    const value = envelope.kid === "legacy" ? await openField(current, developerId, f, sealed) : await openField(oldKey, developerId, f, sealed);
    fields[f] = await sealField(current, developerId, f, value);
  }
  const next: Envelope = { v: SECRET_FORMAT, kid: await keyId(current), fields, savedAt: envelope.savedAt };
  await Db.from(env).putSecretsBlob(developerId, JSON.stringify(next), new Date().toISOString());
}

export async function saveSecrets(env: Env, developerId: string, secrets: DeveloperSecrets, now: Date): Promise<void> {
  const { current } = masterKeys(env);
  const fields: Envelope["fields"] = {};
  for (const f of SECRET_FIELDS) if (secrets[f]) fields[f] = await sealField(current, developerId, f, secrets[f]!);
  const envelope: Envelope = { v: SECRET_FORMAT, kid: await keyId(current), fields, savedAt: secrets.savedAt ?? {} };
  await Db.from(env).putSecretsBlob(developerId, JSON.stringify(envelope), now.toISOString());
}

export function appleReady(s: DeveloperSecrets): boolean {
  return Boolean(s.appleIssuerId && s.appleKeyId && s.applePrivateKey);
}
