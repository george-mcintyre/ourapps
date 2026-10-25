// Copyright Level N Ltd 2026
// Certificate request encoding shared with the browser signing helper.
function len(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}
function tlv(tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = [tag, ...len(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}
function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, cat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, cat(...parts));
const bytes = (...b: number[]) => new Uint8Array(b);
const OID_CN = bytes(0x06, 0x03, 0x55, 0x04, 0x03);
const SHA256_RSA = seq(bytes(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), bytes(0x05, 0x00));
function pem(label: string, der: Uint8Array): string {
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(s).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}
export async function signingRequest(commonName = "ourapps"): Promise<{ csr: string; privateKey: string }> {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const keys = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer);
  const subject = seq(set(seq(OID_CN, tlv(0x0c, new TextEncoder().encode(commonName)))));
  const info = seq(bytes(0x02, 0x01, 0x00), subject, spki, bytes(0xa0, 0x00));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, info));
  const csr = seq(info, SHA256_RSA, tlv(0x03, cat(bytes(0x00), signature)));
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  return { csr: pem("CERTIFICATE REQUEST", csr), privateKey: pem("PRIVATE KEY", pkcs8) };
}
