import { test, expect } from "@playwright/test";
import { intent } from "../helpers";

for (const origin of [
  "http://127.0.0.1:3101",
  "http://127.0.0.1:3110",
  "http://localhost:3110",
]) {
  test(`browser writes work and foreign origins stay blocked at ${origin}`, async ({
    page,
    request,
  }) => {
    await page.goto(origin);
    const saved = await page.evaluate(async (data) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: response.status, body: await response.json() };
    }, intent);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);

    const persisted = await request.get(`${origin}/api/tasks/${saved.body.id}`);
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).intent.query).toBe(intent.query);

    // Exercise the actual proxy and backend guard, not a mocked response.
    for (const foreignOrigin of [
      "https://unrelated.example",
      "http://127.0.0.1:3999",
    ]) {
      const rejected = await request.post(`${origin}/api/tasks`, {
        headers: { Origin: foreignOrigin },
        data: intent,
      });
      expect(rejected.status()).toBe(403);
      expect(await rejected.json()).toEqual({
        error: "Cross-origin writes are not allowed",
      });
    }
  });
}
