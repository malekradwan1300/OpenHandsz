import type { Backend } from "../backend-registry/types";

/**
 * OpenHands Cloud applies a shared limit of 10 API calls per second. Keep a
 * small margin below that limit because a page can initialise several Cloud
 * queries at once (backend status, user, organisation, and conversations).
 */
export const CLOUD_REQUEST_MIN_INTERVAL_MS = 125;

type RequestTask<T> = () => Promise<T>;

const nextStartAtByBackend = new Map<string, number>();
const inFlightGetRequests = new Map<string, Promise<unknown>>();

function schedulerKey(backend: Backend): string {
  // The backend id is a locally stable identity for a Cloud configuration. Do
  // not include API keys in an in-memory diagnostic/key string.
  return backend.id;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runAtNextCloudSlot<T>(
  backend: Backend,
  task: RequestTask<T>,
): Promise<T> {
  const key = schedulerKey(backend);
  const now = Date.now();
  const startAt = Math.max(now, nextStartAtByBackend.get(key) ?? now);

  // Reserve the slot before waiting. This makes simultaneous callers form a
  // deterministic queue rather than all passing the same timing check.
  nextStartAtByBackend.set(key, startAt + CLOUD_REQUEST_MIN_INTERVAL_MS);
  await wait(startAt - now);
  return task();
}

/**
 * Schedules a direct Cloud API request below the provider's shared rate limit.
 * Identical GETs are coalesced while in flight, which prevents duplicate query
 * observers or near-simultaneous invalidations from issuing redundant calls.
 */
export function scheduleCloudRequest<T>(
  backend: Backend,
  options: {
    method: string;
    path: string;
    dedupeKey?: string;
  },
  task: RequestTask<T>,
): Promise<T> {
  const isIdempotentGet = options.method.toUpperCase() === "GET";
  const key = isIdempotentGet
    ? `${schedulerKey(backend)}\u0000${options.dedupeKey ?? options.path}`
    : null;

  if (key) {
    const existing = inFlightGetRequests.get(key);
    if (existing) return existing as Promise<T>;
  }

  const request = runAtNextCloudSlot(backend, task);
  if (key) {
    inFlightGetRequests.set(key, request);
    void request.then(
      () => {
        if (inFlightGetRequests.get(key) === request) {
          inFlightGetRequests.delete(key);
        }
      },
      () => {
        if (inFlightGetRequests.get(key) === request) {
          inFlightGetRequests.delete(key);
        }
      },
    );
  }

  return request;
}

/** Test-only reset for module-level scheduling state. */
export function __resetCloudRequestSchedulerForTests(): void {
  nextStartAtByBackend.clear();
  inFlightGetRequests.clear();
}
