import { timingSafeEqual as nativeTimingSafeEqual } from "node:crypto";

export function readJsonBody(request, { maxBytes = 256 * 1024 } = {}) {
  const normalizedMaxBytes = normalizeMaxBytes(maxBytes);

  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    let size = 0;
    let done = false;

    function fail(error) {
      if (done) {
        return;
      }

      done = true;
      rejectPromise(error);
    }

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (done) {
        return;
      }

      size += Buffer.byteLength(chunk);
      if (size > normalizedMaxBytes) {
        const error = new Error(
          `request body exceeds the ${normalizedMaxBytes} byte limit`,
        );
        error.statusCode = 413;
        fail(error);
        return;
      }

      body += chunk;
    });
    request.on("end", () => {
      if (done) {
        return;
      }

      try {
        done = true;
        resolvePromise(body === "" ? {} : JSON.parse(body));
      } catch (error) {
        fail(new Error(`invalid json body: ${error.message}`));
      }
    });
    request.on("error", fail);
  });
}

export function sendJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });
}

export function parseBearerToken(request) {
  const header = String(request.headers.authorization ?? "").trim();
  if (header === "") {
    return null;
  }

  const matched = header.match(/^Bearer\s+(.+)$/i);
  return matched ? matched[1].trim() : null;
}

export function assertBearerToken(request, expectedToken) {
  const normalizedExpected = String(expectedToken ?? "").trim();
  if (normalizedExpected === "") {
    throw new Error("expected bearer token is required");
  }

  const actualToken = parseBearerToken(request);
  if (!actualToken || !timingSafeEqual(actualToken, normalizedExpected)) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return nativeTimingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeMaxBytes(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }

  return value;
}
