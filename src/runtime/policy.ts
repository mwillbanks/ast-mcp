import { currentConfig } from "../config";

export async function requireExpectedHash(
  expectedSha256: string | undefined,
  operation: string,
): Promise<void> {
  if (!expectedSha256 && (await currentConfig()).safety.requireHash)
    throw Object.assign(
      new Error(
        `${operation} requires expectedSha256 while safety.require_hash is enabled`,
      ),
      { code: "missing_hash", retryable: true, suggestedNextCall: "file_hash" },
    );
}

export function verifyExpectedHash(
  expectedSha256: string | undefined,
  actualSha256: string,
): void {
  if (expectedSha256 && expectedSha256 !== actualSha256)
    throw Object.assign(
      new Error(
        `Stale file context: expected ${expectedSha256}, found ${actualSha256}`,
      ),
      {
        code: "stale_hash",
        details: { expectedSha256, actualSha256 },
        retryable: true,
        suggestedNextCall:
          "file_hash then file_read before rebuilding the patch",
      },
    );
}
