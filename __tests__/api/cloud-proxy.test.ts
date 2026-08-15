import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "#/api/backend-registry/types";

const {
  requestMock,
  createCloudClientMock,
  createRuntimeClientMock,
  scheduleMock,
} = vi.hoisted(() => ({
  requestMock: vi.fn(),
  createCloudClientMock: vi.fn(),
  createRuntimeClientMock: vi.fn(),
  scheduleMock: vi.fn(),
}));

vi.mock("#/api/cloud/client", () => ({
  createCloudClient: createCloudClientMock,
  createCloudClientForRuntime: createRuntimeClientMock,
}));

vi.mock("#/api/cloud/request-scheduler", () => ({
  scheduleCloudRequest: scheduleMock,
}));

import { callCloudProxy } from "#/api/cloud/proxy";

const backend: Backend = {
  id: "cloud-1",
  name: "Cloud",
  kind: "cloud",
  host: "https://app.all-hands.dev",
  apiKey: "api-key",
};

describe("callCloudProxy transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestMock.mockResolvedValue({ items: [] });
    createCloudClientMock.mockReturnValue({ request: requestMock });
    createRuntimeClientMock.mockReturnValue({ request: requestMock });
    scheduleMock.mockImplementation(
      (_backend: Backend, _options: unknown, task: () => Promise<unknown>) =>
        task(),
    );
  });

  it("routes normal Cloud API GETs through the same-origin proxy", async () => {
    await callCloudProxy({
      backend,
      method: "GET",
      path: "/api/v1/conversation/conv-1/events/search?limit=10",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/conversation/conv-1/events/search?limit=10",
        hostOverride: backend.host,
      }),
    );
  });

  it("keeps runtime calls targeted at their runtime host", async () => {
    await callCloudProxy({
      backend,
      method: "GET",
      hostOverride: "https://runtime.example.com",
      path: "/api/git/commits",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/git/commits",
        hostOverride: "https://runtime.example.com",
      }),
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
