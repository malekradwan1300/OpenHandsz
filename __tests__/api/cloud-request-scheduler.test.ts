import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "#/api/backend-registry/types";
import {
  __resetCloudRequestSchedulerForTests,
  scheduleCloudRequest,
} from "#/api/cloud/request-scheduler";

const backend: Backend = {
  id: "cloud-scheduler-test",
  name: "Cloud",
  host: "https://app.all-hands.dev",
  apiKey: "test-key",
  kind: "cloud",
};

describe("scheduleCloudRequest GET deduplication", () => {
  beforeEach(() => {
    __resetCloudRequestSchedulerForTests();
  });

  it("shares an in-flight request and caches its successful result", async () => {
    let resolveRequest: ((value: { ok: true }) => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = scheduleCloudRequest(
      backend,
      { method: "GET", path: "/same", cacheTtlMs: 10_000 },
      task,
    );
    const second = scheduleCloudRequest(
      backend,
      { method: "GET", path: "/same", cacheTtlMs: 10_000 },
      task,
    );

    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    resolveRequest?.({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    await expect(
      scheduleCloudRequest(
        backend,
        { method: "GET", path: "/same", cacheTtlMs: 10_000 },
        task,
      ),
    ).resolves.toEqual({ ok: true });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not cache rejected requests", async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("recovered");

    await expect(
      scheduleCloudRequest(
        backend,
        { method: "GET", path: "/retry", cacheTtlMs: 10_000 },
        task,
      ),
    ).rejects.toThrow("temporary");

    await expect(
      scheduleCloudRequest(
        backend,
        { method: "GET", path: "/retry", cacheTtlMs: 10_000 },
        task,
      ),
    ).resolves.toBe("recovered");
    expect(task).toHaveBeenCalledTimes(2);
  });
});
