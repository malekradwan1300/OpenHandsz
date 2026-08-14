const CLOUD_PROXY_PATH = "/api/cloud-proxy";
const ALLOWED_RUNTIME_DOMAIN = ".all-hands.dev";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isAllowedRuntimeHost(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "all-hands.dev" ||
        url.hostname.endsWith(ALLOWED_RUNTIME_DOMAIN))
    );
  } catch {
    return false;
  }
}

function buildUpstreamUrl(host, path) {
  const base = new URL(host);
  if (!path.startsWith("/")) {
    throw new Error("The proxied path must begin with '/'.");
  }

  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new Error("The proxied path must remain on the requested host.");
  }
  return target;
}

function upstreamHeaders(input) {
  const result = new Headers();
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalized = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      normalized !== "host" &&
      normalized !== "content-length"
    ) {
      result.set(name, value);
    }
  }
  return result;
}

function responseHeaders(input) {
  const result = new Headers();
  for (const [name, value] of input.entries()) {
    const normalized = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(normalized)) {
      result.set(name, value);
    }
  }
  return result;
}

async function proxyCloudRuntime(request) {
  let envelope;
  try {
    envelope = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON proxy request." });
  }

  const { host, method, path, headers, body } = envelope ?? {};
  if (!isAllowedRuntimeHost(host)) {
    return jsonResponse(400, {
      error: "Only HTTPS OpenHands Cloud runtime hosts may be proxied.",
    });
  }
  if (typeof method !== "string" || typeof path !== "string") {
    return jsonResponse(400, {
      error: "A proxy request requires string method and path fields.",
    });
  }

  let target;
  try {
    target = buildUpstreamUrl(host, path);
  } catch (error) {
    return jsonResponse(400, {
      error: error instanceof Error ? error.message : "Invalid proxy path.",
    });
  }

  const upperMethod = method.toUpperCase();
  const init = {
    method: upperMethod,
    headers: upstreamHeaders(headers),
    redirect: "manual",
  };
  if (body != null && upperMethod !== "GET" && upperMethod !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!init.headers.has("Content-Type")) {
      init.headers.set("Content-Type", "application/json");
    }
  }

  try {
    const upstream = await fetch(target, init);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    });
  } catch (error) {
    return jsonResponse(502, {
      error: "Unable to reach the Cloud runtime.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === CLOUD_PROXY_PATH) {
      if (request.method !== "POST") {
        return jsonResponse(405, { error: "Method not allowed." });
      }
      return proxyCloudRuntime(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export {
  buildUpstreamUrl,
  isAllowedRuntimeHost,
  proxyCloudRuntime,
  responseHeaders,
  upstreamHeaders,
};
