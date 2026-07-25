export function normalizeBaseUrl(baseUrl: string): string {
  const leadingSlash = baseUrl.startsWith("/") ? baseUrl : `/${baseUrl}`;
  return leadingSlash.endsWith("/") ? leadingSlash : `${leadingSlash}/`;
}
