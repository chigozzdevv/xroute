const FALLBACK_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";

export const DEFAULT_XROUTE_API_BASE_URL = resolveDefaultXRouteApiBaseUrl();

export function assertNoBaseUrlOverride(apiName, options = {}) {
  if (options?.baseUrl === undefined || options?.baseUrl === null) {
    return;
  }

  throw new Error(`${apiName} does not support baseUrl overrides`);
}

function resolveDefaultXRouteApiBaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_XROUTE_API_BASE_URL,
    process.env.XROUTE_API_BASE_URL,
    process.env.XROUTE_API_SERVER_BASE_URL,
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      return normalized.replace(/\/+$/, "");
    }
  }

  return FALLBACK_XROUTE_API_BASE_URL;
}
