import { HttpError } from "./http.js";

export interface ExistingUploadOperation {
  method: "PUT" | "POST";
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
}

export function uploadInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.length > 32 || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

export function validateExistingUploadOperations(input: unknown, fileSize: number): ExistingUploadOperation[] {
  const invalid = () => new HttpError(502, "Apple upload operations are invalid.");
  if (!Array.isArray(input) || input.length === 0 || input.length > 128) throw invalid();
  const operations = input.map((item): ExistingUploadOperation => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const op = item as Record<string, unknown>;
    if (op.method !== "PUT" && op.method !== "POST") throw invalid();
    if (typeof op.url !== "string" || op.url.length > 16384 || /[\u0000-\u0020\u007f]/.test(op.url)) throw invalid();
    try {
      const url = new URL(op.url);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw invalid();
    } catch { throw invalid(); }
    const offset = uploadInteger(op.offset, 0);
    const length = uploadInteger(op.length, 1);
    if (offset === null || length === null || !Number.isSafeInteger(offset + length) || offset + length > fileSize) throw invalid();
    if (op.requestHeaders !== undefined && !Array.isArray(op.requestHeaders)) throw invalid();
    const rawHeaders = op.requestHeaders as unknown[] | undefined;
    if (rawHeaders && rawHeaders.length > 64) throw invalid();
    const requestHeaders = (rawHeaders ?? []).map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
      const header = raw as Record<string, unknown>;
      if (typeof header.name !== "string" || header.name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) throw invalid();
      if (typeof header.value !== "string" || header.value.length > 8192 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(header.value)) throw invalid();
      return { name: header.name, value: header.value };
    });
    return { method: op.method, url: op.url, offset, length, requestHeaders };
  });
  let end = 0;
  for (const op of operations.slice().sort((a, b) => a.offset - b.offset)) {
    if (op.offset !== end) throw invalid();
    end += op.length;
  }
  if (end !== fileSize) throw invalid();
  return operations;
}
