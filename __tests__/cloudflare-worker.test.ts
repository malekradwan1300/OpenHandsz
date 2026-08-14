import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../cloudflare-worker.mjs";

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function cloudProxyRequest(payload: unknown): Request {
  return new Request("https://openhandsz.example.workers.dev/api/cloud-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Cloudflare cloud proxy", () => {
  it("forwards an allowed Cloud runtime request and preserves its JSON response", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "conv-1", execution_status: "idle" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await worker.fetch(
      cloudProxyRequest({
        host: "https://tenant.prod-runtime.all-hands.dev",
        method: "GET",
        path: "/api/conversations/conv-1",
        headers: { "X-Session-API-Key": "session-key" },
        body: null,
      }),
      { ASSETS: { fetch: vi.fn() } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "conv-1",
      execution_status: "idle",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://tenant.prod-runtime.all-hands.dev/api/conversations/conv-1",
      ),
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Headers).get("X-Session-API-Key")).toBe(
      "session-key",
    );
  });

  it("rejects arbitrary external hosts before they can be fetched", async () => {
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      cloudProxyRequest({
        host: "https://untrusted.example",
        method: "GET",
        path: "/api/conversations/conv-1",
      }),
      { ASSETS: { fetch: vi.fn() } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Only HTTPS OpenHands Cloud runtime hosts may be proxied.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps regular frontend requests on the static asset handler", async () => {
    const assetFetch = vi.fn().mockResolvedValue(new Response("application"));

    const response = await worker.fetch(
      new Request("https://openhandsz.example.workers.dev/conversations/conv-1"),
      { ASSETS: { fetch: assetFetch } },
    );

    expect(await response.text()).toBe("application");
    expect(assetFetch).toHaveBeenCalledOnce();
  });
});
