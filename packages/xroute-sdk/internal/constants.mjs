const HOSTED_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";
const LOCAL_XROUTE_API_BASE_URL = "http://127.0.0.1:8788/v1";

export const DEFAULT_XROUTE_API_BASE_URL = HOSTED_XROUTE_API_BASE_URL;

export function assertNoBaseUrlOverride(apiName, options = {}) {
  if (options?.baseUrl === undefined || options?.baseUrl === null) {
    return;
  }

  throw new Error(`${apiName} does not support baseUrl overrides`);
}

export function resolveDefaultXRouteApiBaseUrl({
  env = typeof process === "undefined" ? undefined : process.env,
  location = globalThis.location,
} = {}) {
  const candidates = [
    env?.XROUTE_API_BASE_URL,
    env?.XROUTE_API_SERVER_BASE_URL,
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      return normalized.replace(/\/+$/, "");
    }
  }

  if (isLocalBrowserLocation(location)) {
    return `http://${location?.hostname || "127.0.0.1"}:8788/v1`;
  }

  return HOSTED_XROUTE_API_BASE_URL;
}

function isLocalBrowserLocation(location) {
  const hostname = location?.hostname?.trim().toLowerCase() || "";
  return (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || hostname.startsWith("192.168.")
    || hostname.startsWith("10.")
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  );
}
