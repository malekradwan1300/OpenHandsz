import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "#/api/backend-registry/types";
import {
  __resetCloudRequestSchedulerForTests,
  CLOUD_REQUEST_MIN_INTERVAL_MS,
  scheduleCloudRequest,
} from "#/api/cloud/request-scheduler";

const cloudBackend: Backend = {
  id: "cloud-personal",
  name: "OpenHands Cloud",
  host: "https://app.all-hands.dev",
  apiKey: "test-key",
  kind: "cloud",
};

afterEach(() => {
  __resetCloudRequestSchedulerForTests();
  vi.useRealTimers();
});

describe("scheduleCloudRequest", () => {
  it("coalesces identical GETs while the first request is pending", async () => {
    let resolveRequest: ((value: { items: string[] }) => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<{ items: string[] }>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = scheduleCloudRequest(
      cloudBackend,
      { method: "GET", path: "/api/v1/app-conversations/search?limit=20" },
      task,
    );
    const second = scheduleCloudRequest(
      cloudBackend,
      { method: "GET", path: "/api/v1/app-conversations/search?limit=20" },
      task,
    );

    await Promise.resolve();
    expect(first).toBe(second);
    expect(task).toHaveBeenCalledTimes(1);

    resolveRequest?.({ items: [] });
    await expect(first).resolves.toEqual({ items: [] });
  });

  it("spaces distinct Cloud API requests below the provider rate limit", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const firstTask = vi.fn(async () => {
      starts.push(Date.now());
      return "first";
    });
    const secondTask = vi.fn(async () => {
      starts.push(Date.now());
      return "second";
    });

    const first = scheduleCloudRequest(
      cloudBackend,
      { method: "GET", path: "/api/v1/users/me" },
      firstTask,
    );
    const second = scheduleCloudRequest(
      cloudBackend,
      { method: "GET", path: "/api/v1/app-conversations/search?limit=20" },
      secondTask,
    );

    await vi.runAllTimersAsync();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).toHaveBeenCalledTimes(1);
    expect(starts[1]! - starts[0]!).toBe(CLOUD_REQUEST_MIN_INTERVAL_MS);
  });

  it("does not coalesce mutations, while still spacing them safely", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);

    const first = scheduleCloudRequest(
      cloudBackend,
      { method: "POST", path: "/api/v1/app-conversations" },
      task,
    );
    const second = scheduleCloudRequest(
      cloudBackend,
      { method: "POST", path: "/api/v1/app-conversations" },
      task,
    );

    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
