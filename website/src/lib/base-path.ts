export function normalizeBasePath(value: string): string {
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path)) {
    throw new Error(
      "BASE_PATH must be an absolute URL path without a query or fragment.",
    );
  }
  return path.replace(/\/+$/, "") + "/";
}
