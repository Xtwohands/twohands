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
export function setToken(value: string) {
  accessToken = value;
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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
