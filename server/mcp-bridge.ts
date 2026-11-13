export interface BridgeConfiguration {
  readonly baseUrl: string;
  readonly https: boolean;
  readonly credential: string;
}
export interface BridgeClient {
  clientName: string;
  clientVersion: string;
}
const invalidUrl =
  "APILAYER_URL must be loopback HTTP or explicit HTTPS, ending in /api, without URL credentials, query strings or fragments.";

/** Explicit HTTPS configuration is the remote opt-in; owner credentials stay local. */
export function bridgeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfiguration {
  const raw = env.APILAYER_URL || "http://127.0.0.1:3001/api";
  let base: URL;
  try {
    if (raw.length > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(raw))
      throw new Error();
    base = new URL(raw);
  } catch {
    throw new Error(invalidUrl);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  const path = base.pathname.replace(/\/$/, "");
  if (
    (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) ||
    base.username ||
    base.password ||
    !/^\/(?:[A-Za-z0-9_~.-]+\/)*api$/.test(path)
  )
    throw new Error(invalidUrl);
  const https = base.protocol === "https:";
  const credential = env.APILAYER_API_KEY || (https ? "" : env.API_TOKEN || "");
  if (https && !/^oct_key_[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error(
      "HTTPS bridge connections require a scoped APILAYER_API_KEY. API_TOKEN is never sent over a hosted bridge.",
    );
  if (credential.length > 4096 || /[^\x21-\x7e]/.test(credential))
    throw new Error("Invalid bridge credential configuration.");
  return Object.freeze({ baseUrl: `${base.origin}${path}`, https, credential });
}
export function bridgeClientIdentity(
  name?: string,
  version?: string,
): BridgeClient {
  return {
    clientName: name?.trim().slice(0, 160) || "Unknown MCP client",
    clientVersion: version?.trim().slice(0, 100) || "Unknown",
  };
}
function transportFailure(settings: BridgeConfiguration) {
  return new Error(
    `${settings.https ? "The configured Two Hands HTTPS server could not be reached or the request timed out. Check APILAYER_URL and server availability." : "The local Two Hands server could not be reached or the request timed out. Keep npm start running and check APILAYER_URL."} A submitted operation may still have run: inspect its saved receipt and reuse the same request key and arguments if retrying.`,
  );
}
function statusFailure(status: number) {
  const message =
    status === 401
      ? "The bridge credential was rejected. Check the configured key; no owner-token fallback was attempted."
      : status === 403
        ? "The bridge key does not permit this operation."
        : status === 409
          ? "The operation conflicts with saved state or backend policy. Inspect the existing session and receipt before retrying."
          : status === 429
            ? "The backend request or spending limit was reached. No automatic retry was made."
            : "The configured server rejected the bridge operation.";
  return new Error(`${message} HTTP ${status}.`);
}

/** One fixed origin, no redirects/retries, normal TLS, bounded JSON and one deadline. */
export function createBridgeRequest(
  settings: BridgeConfiguration,
  client: () => BridgeClient | undefined = () => undefined,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
  } = {},
) {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 135000,
    maxBytes = options.maxResponseBytes ?? 2_000_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 135000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 2_000_000
  )
    throw new Error("Invalid bridge transport limits.");
  const origin = new URL(settings.baseUrl).origin;
  return async (path: string, body?: unknown): Promise<any> => {
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path))
      throw new Error("Invalid bridge operation path.");
    const target = new URL(`${settings.baseUrl}${path}`);
    if (target.origin !== origin)
      throw new Error("Bridge requests must stay on the configured origin.");
    let encoded: string | undefined;
    try {
      encoded = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new Error("Invalid bridge request body.");
    }
    if (encoded && Buffer.byteLength(encoded) > 200000)
      throw new Error("Bridge request exceeds its size limit.");
    const reported = client();
    const identity = reported
      ? bridgeClientIdentity(reported.clientName, reported.clientVersion)
      : undefined;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetcher(target.href, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(identity
            ? {
                "X-APILayer-MCP-Client": Buffer.from(
                  JSON.stringify(identity),
                ).toString("base64url"),
              }
            : {}),
          ...(settings.credential
            ? { Authorization: `Bearer ${settings.credential}` }
            : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: encoded,
        redirect: "error",
        signal,
      });
    } catch {
      throw transportFailure(settings);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusFailure(response.status);
    }
    if (
      !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        "The configured server returned an invalid JSON response.",
      );
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Bridge response exceeds its size limit.");
    }
    if (!response.body)
      throw new Error("The configured server returned an empty response.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("size");
        }
        chunks.push(value);
      }
    } catch {
      if (signal.aborted) throw transportFailure(settings);
      throw new Error(
        "The configured server returned an incomplete or oversized response. Inspect saved receipts before retrying.",
      );
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (settings.credential.length >= 8 && text.includes(settings.credential))
      throw new Error(
        "The configured server returned sensitive bridge credential content.",
      );
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error();
      return data;
    } catch {
      throw new Error(
        "The configured server returned an invalid JSON response.",
      );
    }
  };
}
