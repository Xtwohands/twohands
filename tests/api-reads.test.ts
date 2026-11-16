import { afterEach, expect, it, vi } from "vitest";
import { api, setAccountSession, setPreviewRole } from "../src/api";
afterEach(() => {
  setPreviewRole(null);
  setAccountSession("", "");
  vi.unstubAllGlobals();
});
it("deduplicates simultaneous reads but never caches completed reads or writes", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((r) => resolvers.push(r)));
  vi.stubGlobal("fetch", fetch);
  setAccountSession("fixture-token", "fixture-user");
  const first = api("/account/usage"),
    second = api("/account/usage");
  expect(fetch).toHaveBeenCalledTimes(1);
  resolvers[0](new Response('{"requests":1}'));
  expect(await first).toEqual(await second);
  const next = api("/account/usage");
  expect(fetch).toHaveBeenCalledTimes(2);
  resolvers[1](new Response("{}"));
  await next;
  const a = api("/observations", { title: "a" }),
    b = api("/observations", { title: "b" });
  expect(fetch).toHaveBeenCalledTimes(4);
  resolvers[2](new Response('{"created":"a"}'));
  resolvers[3](new Response('{"created":"b"}'));
  expect(await a).toEqual({ created: "a" });
  expect(await b).toEqual({ created: "b" });
});
it("keeps pending reads separate across account and preview changes", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((r) => resolvers.push(r)));
  vi.stubGlobal("fetch", fetch);
  setAccountSession("token-a", "a");
  const old = api("/account/usage");
  setAccountSession("token-b", "b");
  const current = api("/account/usage");
  resolvers[0](new Response('{"owner":"a"}'));
  await expect(old).rejects.toThrow(/Account changed/);
  resolvers[1](new Response('{"owner":"b"}'));
  expect(await current).toEqual({ owner: "b" });
  const normal = api("/account/routing");
  setPreviewRole("user");
  const preview = api("/account/routing");
  expect(fetch).toHaveBeenCalledTimes(4);
  resolvers[2](new Response("{}"));
  await expect(normal).rejects.toThrow(/Account changed/);
  resolvers[3](new Response("{}"));
  await preview;
});
