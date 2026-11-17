import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { staticAssets } from "../server/static-assets";
const app = express();
staticAssets(app);
const server = app.listen(0, "127.0.0.1");
let base: string;
beforeAll(async () => {
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await once(server, "close");
});
it("serves the same JavaScript with gzip/Brotli, correct MIME, Vary, and immutable caching", async () => {
  const html = await fetch(base);
  expect(html.headers.get("cache-control")).toBe("no-cache");
  const path = (await html.text()).match(/src="([^\"]+\.js)"/)![1];
  const plain = await fetch(base + path, {
      headers: { "Accept-Encoding": "identity" },
    }),
    body = await plain.text();
  for (const encoding of ["br", "gzip"]) {
    const r = await fetch(base + path, {
      headers: { "Accept-Encoding": encoding },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBe(encoding);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.headers.get("vary")).toContain("Accept-Encoding");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(Number(r.headers.get("content-length"))).toBeLessThan(
      Buffer.byteLength(body) * 0.5,
    );
    expect(await r.text()).toBe(body);
  }
  const missing = await fetch(base + "/assets/missing.js", {
    headers: { "Accept-Encoding": "br" },
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-encoding")).toBeNull();
});
it("serves the public legal pages at /privacy and /terms", async () => {
  for (const [path, title] of [
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
  ]) {
    const r = await fetch(base + path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(await r.text()).toContain(`<h1>${title}</h1>`);
  }
});
