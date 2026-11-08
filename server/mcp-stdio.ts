import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createObservationMcp } from "./mcp-server.js";
const base = new URL(process.env.APILAYER_URL || "http://127.0.0.1:3001/api");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  base.protocol !== "http:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw new Error(
    "The local MCP bridge requires a loopback HTTP APILayer URL.",
  );
const credential = process.env.APILAYER_API_KEY || process.env.API_TOKEN;
let client: { clientName: string; clientVersion: string } | undefined;
const request = async (path: string, body?: unknown) => {
  const response = await fetch(`${base.href.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(client
        ? {
            "X-APILayer-MCP-Client": Buffer.from(
              JSON.stringify(client),
            ).toString("base64url"),
          }
        : {}),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(135000),
  }).catch(() => {
    throw new Error(
      "The local APILayer server could not be reached or the request timed out. Keep npm start running and check APILAYER_URL. A submitted operation may still have run: inspect its saved receipt and reuse the same request key and arguments if retrying.",
    );
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `APILayer returned HTTP ${response.status}`);
  return data;
};
const server = createObservationMcp(request);
server.server.oninitialized = () => {
  const version = server.server.getClientVersion();
  client = {
    clientName: version?.name || "Unknown MCP client",
    clientVersion: version?.version || "Unknown",
  };
  void request("/observations/connection", client).catch(() => {});
};
await server.connect(new StdioServerTransport());
