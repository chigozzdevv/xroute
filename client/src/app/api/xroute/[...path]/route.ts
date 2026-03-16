const DEFAULT_XROUTE_API_SERVER_BASE_URL = "https://xroute-api.onrender.com/v1";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeBaseUrl(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_XROUTE_API_SERVER_BASE_URL;
  }

  return normalized.replace(/\/+$/, "");
}

function buildUpstreamUrl(baseUrl: string, path: string[], search: string) {
  const upstream = new URL(`${baseUrl}/${path.map(encodeURIComponent).join("/")}`);
  upstream.search = search;
  return upstream;
}

function copyRequestHeaders(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  return headers;
}

async function proxyRequest(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path = [] } = await params;
  const upstreamUrl = buildUpstreamUrl(
    normalizeBaseUrl(process.env.XROUTE_API_SERVER_BASE_URL),
    path,
    new URL(request.url).search,
  );

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: copyRequestHeaders(request),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Upstream XRoute API request failed.",
      },
      { status: 502 },
    );
  }
}

export { proxyRequest as GET };
export { proxyRequest as POST };
export { proxyRequest as PUT };
export { proxyRequest as PATCH };
export { proxyRequest as DELETE };
export { proxyRequest as OPTIONS };
