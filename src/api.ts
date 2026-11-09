import type { Task, TraceEvent } from "../server/types";
export type TaskDetail = Task & {
  events: TraceEvent[];
  organizations: {
    name: string;
    sources: { id: string; title: string; url: string }[];
    notes: string[];
    criteria: Record<string, string[]>;
  }[];
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let accessToken = "";
let previewRole: "user" | "company" | null = null;
let previewTarget: string | null = null;
export function setPreviewRole(
  role: typeof previewRole,
  target: string | null = null,
) {
  previewRole = role;
  previewTarget = role === "company" ? target : null;
  contextEpoch++;
}
let workspaceId = "",
  accountId = "",
  contextEpoch = 0;
export function setAccountSession(
  token: string,
  workspace: string,
  userId: string,
) {
  if (workspaceId !== workspace || accountId !== userId) contextEpoch++;
  accessToken = token;
  workspaceId = workspace;
  accountId = userId;
}
export function apiHeaders(): Record<string, string> {
  return {
    ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
    ...(workspaceId ? { "X-Octolab-Workspace": workspaceId } : {}),
    ...(previewRole ? { "X-Octolab-Preview": previewRole } : {}),
    ...(previewTarget ? { "X-Octolab-Preview-Target": previewTarget } : {}),
  };
}
export function setToken(value: string) {
  contextEpoch++;
  accessToken = value;
  workspaceId = "";
  accountId = "";
  previewRole = null;
  previewTarget = null;
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const epoch = contextEpoch,
    token = accessToken;
  const response = await fetch(`/api${path}`, {
    headers: {
      ...apiHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(/\/(run|fetch)$/.test(path) && body !== undefined
        ? { "Idempotency-Key": crypto.randomUUID() }
        : {}),
    },
    ...(body !== undefined
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  const data = await response.json();
  if (epoch !== contextEpoch)
    throw new ApiError(
      "Workspace changed. The earlier response was discarded.",
      409,
    );
  if (response.status === 401 && accountId && token === accessToken)
    window.dispatchEvent(new Event("octolab-session-invalid"));
  if (!response.ok)
    throw new ApiError(
      data.error || `Request failed (${response.status})`,
      response.status,
    );
  return data;
}
export function money(micros: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 6,
  }).format(micros / 1e6);
}
export function shortDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
