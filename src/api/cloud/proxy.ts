import type { CloudRequestOptions } from "@openhands/typescript-client/clients";
import type { Backend } from "../backend-registry/types";
import { createCloudClientForRuntime, createCloudClient } from "./client";
import { scheduleCloudRequest } from "./request-scheduler";

export interface CloudProxyRequest {
  backend: Backend;
  method: CloudRequestOptions["method"];
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  /** Cache successful direct Cloud GETs for this many milliseconds. */
  cacheTtlMs?: number;
  hostOverride?: string;
  authMode?: "bearer" | "session-api-key" | "none";
  sessionApiKey?: string | null;
  responseType?: "blob";
}

export async function callCloudProxy<TResponse = unknown>(
  req: CloudProxyRequest,
): Promise<TResponse> {
  const client = req.hostOverride
    ? createCloudClientForRuntime(req.backend)
    : createCloudClient(req.backend);

  const executeRequest = () =>
    client.request<TResponse>({
      method: req.method,
      path: req.path,
      body: req.body,
      headers: req.headers,
      timeoutSeconds: req.timeoutSeconds,
      // The Cloud SDK selects its same-origin proxy transport only when
      // hostOverride is present. Normal Cloud API calls must therefore pass the
      // configured Cloud host explicitly; otherwise the SDK calls
      // app.all-hands.dev directly from the browser and bypasses the Worker.
      hostOverride: req.hostOverride ?? req.backend.host,
      authMode:
        req.authMode === undefined || req.authMode === "bearer"
          ? "bearer"
          : req.authMode,
      sessionApiKey: req.sessionApiKey,
      responseType: req.responseType,
    });

  // Runtime calls use their per-conversation sandbox endpoint. Normal Cloud
  // API calls also use the same-origin Worker: executeRequest supplies the
  // Cloud host as hostOverride so the SDK chooses requestThroughProxy instead
  // of requestDirect. All GETs still share the provider-rate scheduler.
  return req.hostOverride
    ? executeRequest()
    : scheduleCloudRequest(
        req.backend,
        {
          method: req.method,
          path: req.path,
          cacheTtlMs: req.cacheTtlMs,
        },
        executeRequest,
      );
}
