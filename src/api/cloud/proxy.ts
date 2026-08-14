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
      hostOverride: req.hostOverride,
      authMode:
        req.authMode === undefined || req.authMode === "bearer"
          ? "bearer"
          : req.authMode,
      sessionApiKey: req.sessionApiKey,
      responseType: req.responseType,
    });

  // Runtime calls use the per-conversation sandbox endpoint and are already
  // isolated behind the same-origin Worker. Cloud API calls, however, share the
  // provider's 10 requests/second limit with all startup and sidebar queries.
  return req.hostOverride
    ? executeRequest()
    : scheduleCloudRequest(
        req.backend,
        { method: req.method, path: req.path },
        executeRequest,
      );
}
