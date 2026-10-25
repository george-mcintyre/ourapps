type ValueType = "missing" | "null" | "array" | "object" | "string" | "number" | "boolean";
type NumericValue = number | string | null;

export interface UploadFileDiagnostic {
  assetDeliveryState: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED" | null;
  uploaded?: boolean;
  fileSize: NumericValue;
  fileSizeType: ValueType;
  operationCount: number | null;
  operationsTruncated: boolean;
  operations: {
    method: string | null;
    offset: NumericValue;
    length: NumericValue;
    types: { method: ValueType; offset: ValueType; length: ValueType; url: ValueType; requestHeaders: ValueType };
    https: boolean;
    hostname: string | null;
    headerNames: string[];
    headerNamesTruncated: boolean;
  }[];
  coverage: {
    expectedFileSize: number | null;
    fileSizeValid: boolean | null;
    numericValid: boolean | null;
    sortedContiguous: boolean | null;
    nonOverlapping: boolean | null;
    originalOrderContiguous: boolean | null;
    coveredBytes: number | null;
    complete: boolean | null;
  };
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const type = (value: unknown): ValueType => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value as ValueType;
const token = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
const numeric = (value: unknown): NumericValue => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.length <= 32 && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
const integer = (value: NumericValue, minimum: number): number | null => value !== null && Number.isSafeInteger(Number(value)) && Number(value) >= minimum ? Number(value) : null;

export function sanitiseUploadFile(attributes: unknown): UploadFileDiagnostic {
  const a = object(attributes);
  const state = object(a.assetDeliveryState).state;
  const fileSize = numeric(a.fileSize);
  const expectedFileSize = integer(fileSize, 1);
  const raw = Array.isArray(a.uploadOperations) ? a.uploadOperations : null;
  const operationsTruncated = Boolean(raw && raw.length > 128);
  const operations = (raw ?? []).slice(0, 128).map((value) => {
    const op = object(value);
    let https = false;
    let hostname: string | null = null;
    if (typeof op.url === "string" && op.url.length <= 16384) {
      try {
        const url = new URL(op.url);
        https = url.protocol === "https:";
        hostname = url.hostname.length <= 253 && /^[A-Za-z0-9.:[\]-]+$/.test(url.hostname) ? url.hostname : null;
      } catch { /* Invalid addresses have no reported hostname. */ }
    }
    const headers = Array.isArray(op.requestHeaders) ? op.requestHeaders : [];
    return {
      method: token(op.method, 32) ? op.method : null,
      offset: numeric(op.offset), length: numeric(op.length),
      types: { method: type(op.method), offset: type(op.offset), length: type(op.length), url: type(op.url), requestHeaders: type(op.requestHeaders) },
      https, hostname,
      headerNames: headers.slice(0, 32).map((header) => token(object(header).name, 64) ? object(header).name as string : "invalid"),
      headerNamesTruncated: headers.length > 32,
    };
  });
  const intervals = operations.map((op) => ({ offset: integer(op.offset, 0), length: integer(op.length, 1) }));
  const valid = intervals.every((op) => op.offset !== null && op.length !== null && Number.isSafeInteger(op.offset + op.length));
  const numericValid = !raw || operationsTruncated ? valid ? null : false : valid;
  const coverage: UploadFileDiagnostic["coverage"] = {
    expectedFileSize, fileSizeValid: a.fileSize === undefined || a.fileSize === null ? null : expectedFileSize !== null,
    numericValid, sortedContiguous: null, nonOverlapping: null, originalOrderContiguous: null, coveredBytes: null, complete: null,
  };
  if (numericValid === true) {
    let originalEnd = 0;
    coverage.originalOrderContiguous = intervals.every((op) => { const matches = op.offset === originalEnd; originalEnd = op.offset! + op.length!; return matches; });
    const sorted = intervals.slice().sort((x, y) => x.offset! - y.offset!);
    let end = 0;
    let covered = 0;
    coverage.sortedContiguous = true;
    coverage.nonOverlapping = true;
    for (const op of sorted) {
      if (op.offset !== end) coverage.sortedContiguous = false;
      if (op.offset! < end) coverage.nonOverlapping = false;
      const next = op.offset! + op.length!;
      covered += Math.max(0, next - Math.max(end, op.offset!));
      end = Math.max(end, next);
    }
    coverage.coveredBytes = covered;
    coverage.complete = expectedFileSize === null ? null : coverage.sortedContiguous && end === expectedFileSize;
  }
  return {
    assetDeliveryState: state === "AWAITING_UPLOAD" || state === "UPLOAD_COMPLETE" || state === "COMPLETE" || state === "FAILED" ? state : null,
    ...(typeof a.uploaded === "boolean" ? { uploaded: a.uploaded } : {}),
    fileSize, fileSizeType: type(a.fileSize), operationCount: raw?.length ?? null, operationsTruncated, operations, coverage,
  };
}
