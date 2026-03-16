export const DEFAULT_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";

export function assertNoBaseUrlOverride(apiName, options = {}) {
  if (options?.baseUrl === undefined || options?.baseUrl === null) {
    return;
  }

  throw new Error(`${apiName} does not support baseUrl overrides`);
}
