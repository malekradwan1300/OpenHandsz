const CLOUD_PROXY_PATH = "/api/cloud-proxy";
const ALLOWED_RUNTIME_DOMAIN = ".all-hands.dev";
const CLOUD_CONVERSATIONS_PATH = "/api/cloud-conversations";
const CLOUD_SEARCH_PATH = "/api/v1/app-conversations/search";
const DEFAULT_CLOUD_PAGE_LIMIT = 20;
const DEFAULT_CLOUD_MAX_PAGES = 8;
const MAX_CLOUD_PAGE_LIMIT = 50;
const MAX_CLOUD_MAX_PAGES = 20;

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

function isAllowedCloudApiHost(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (hostname === "app.all-hands.dev" ||
        hostname === "all-hands.dev" ||
        hostname === "app.openhands.dev" ||
        hostname === "openhands.dev")
    );
  } catch {
    return false;
  }
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

async function aggregateCloudConversations(request) {
  let envelope;
  try {
    envelope = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON conversation request." });
  }

  const {
    host,
    headers,
    limit = DEFAULT_CLOUD_PAGE_LIMIT,
    max_pages = DEFAULT_CLOUD_MAX_PAGES,
    page_id = null,
  } = envelope ?? {};

  if (!isAllowedCloudApiHost(host)) {
    return jsonResponse(400, {
      error: "Only HTTPS OpenHands Cloud API hosts may be aggregated.",
    });
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    return jsonResponse(400, { error: "limit must be a positive integer." });
  }
  if (
    typeof max_pages !== "number" ||
    !Number.isInteger(max_pages) ||
    max_pages < 1
  ) {
    return jsonResponse(400, {
      error: "max_pages must be a positive integer.",
    });
  }

  const pageLimit = Math.min(limit, MAX_CLOUD_PAGE_LIMIT);
  const pageCount = Math.min(max_pages, MAX_CLOUD_MAX_PAGES);
  const items = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = typeof page_id === "string" && page_id ? page_id : null;
  let nextPageId = cursor;

  try {
    for (let index = 0; index < pageCount; index += 1) {
      const path = new URL(CLOUD_SEARCH_PATH, host);
      path.searchParams.set("limit", String(pageLimit));
      path.searchParams.set("sort_order", "UPDATED_AT_DESC");
      if (cursor) path.searchParams.set("page_id", cursor);

      const upstream = await fetch(path, {
        method: "GET",
        headers: upstreamHeaders(headers),
        redirect: "manual",
      });

      if (!upstream.ok) {
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers),
        });
      }

      const page = await upstream.json();
      for (const item of Array.isArray(page?.items) ? page.items : []) {
        const id = typeof item?.id === "string" ? item.id : null;
        if (!id || !seenIds.has(id)) {
          if (id) seenIds.add(id);
          items.push(item);
        }
      }

      nextPageId =
        typeof page?.next_page_id === "string" ? page.next_page_id : null;
      if (!nextPageId || seenCursors.has(nextPageId)) break;
      seenCursors.add(nextPageId);
      cursor = nextPageId;
    }

    return jsonResponse(200, {
      items,
      // Keep the cursor only when the worker hit its bounded page budget.
      // The UI can request another aggregate batch without seeing the
      // individual upstream pages.
      next_page_id: nextPageId,
    });
  } catch (error) {
    return jsonResponse(502, {
      error: "Unable to aggregate OpenHands Cloud conversations.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
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
    if (url.pathname === CLOUD_CONVERSATIONS_PATH) {
      if (request.method !== "POST") {
        return jsonResponse(405, { error: "Method not allowed." });
      }
      return aggregateCloudConversations(request);
    }

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
  aggregateCloudConversations,
  buildUpstreamUrl,
  isAllowedCloudApiHost,
  isAllowedRuntimeHost,
  proxyCloudRuntime,
  responseHeaders,
  upstreamHeaders,
};
