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
const cachedGetResponses = new Map<
  string,
  { expiresAt: number; value: unknown }
>();

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
    /** Cache successful GET responses for this many milliseconds. */
    cacheTtlMs?: number;
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

    const cached = cachedGetResponses.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.value as T);
      }
      cachedGetResponses.delete(key);
    }
  }

  const request = runAtNextCloudSlot(backend, task);
  if (key) {
    inFlightGetRequests.set(key, request);
    void request.then(
      (value) => {
        inFlightGetRequests.delete(key);
        if (options.cacheTtlMs && options.cacheTtlMs > 0) {
          cachedGetResponses.set(key, {
            value,
            expiresAt: Date.now() + options.cacheTtlMs,
          });
        }
      },
      () => {
        inFlightGetRequests.delete(key);
        // Failed requests are deliberately never cached.
        cachedGetResponses.delete(key);
      },
    );
  }

  return request;
}

/** Test-only reset for module-level scheduling state. */
export function __resetCloudRequestSchedulerForTests(): void {
  nextStartAtByBackend.clear();
  inFlightGetRequests.clear();
  cachedGetResponses.clear();
}
