export class BuildNumberError extends Error {}

export function numericBuildNumber(input: unknown): number {
  if (typeof input !== "string" || !/^\d+$/.test(input)) throw new BuildNumberError("Existing Apple build numbers must be non-negative integers before an automatic build number can be reserved.");
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new BuildNumberError("An existing Apple build number exceeds the safe integer range; an automatic build number cannot be reserved.");
  return value;
}
