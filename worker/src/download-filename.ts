// Copyright Level N Ltd 2026

function decode(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

function safeFilename(value: string | null, format: "exe" | "dmg"): value is string {
  return Boolean(value && value.length <= 180 && value === value.trim() && !value.startsWith(".")
    && !/[\p{Cc}\p{Cf}\p{Cs}\/\\:*?"<>|]/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ]|$)/i.test(value)
    && value.toLowerCase().endsWith(`.${format}`));
}

export function downloadDisposition(disposition: string | null, source: string, format: "exe" | "dmg"): string {
  const extended = disposition?.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/i);
  const plain = disposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  const candidates = [extended ? decode(extended[1].trim()) : null, plain ? (plain[1] ?? plain[2].trim()) : null];
  try { candidates.push(decode(new URL(source).pathname.split("/").pop() ?? "")); } catch { /* No usable source filename. */ }
  const filename = candidates.find(value => safeFilename(value, format)) ?? `app.${format}`;
  const ascii = filename.replace(/[^\x20-\x7e]|%/g, "_");
  const header = `attachment; filename="${ascii}"`;
  if (ascii === filename) return header;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${header}; filename*=UTF-8''${encoded}`;
}
