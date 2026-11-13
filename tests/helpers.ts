import { providerIds } from "../server/provider-catalog";
import { randomUUID } from "node:crypto";
import type { Intent, Task } from "../server/types";
import type { Store } from "../server/store";
export const intent: Intent = {
  prompt: "Find funded agent payment companies with supporting evidence",
  query: "agent payments funding",
  requiredCount: 20,
  budgetMicros: 100000,
  criteria: ["Active", "Funded", "Relevant"],
  domains: [],
  mode: "route",
  preference: "balanced",
  consent: false,
};
export async function createTask(
  store: Store,
  overrides: Partial<Intent> = {},
): Promise<Task> {
  const t: Task = {
    id: randomUUID(),
    intent: { ...intent, ...overrides },
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spentMicros: 0,
    reservedMicros: 0,
    sources: [],
    assessments: [],
  };
  await store.save(t);
  return t;
}
export function providerResults(provider: "exa" | "tavily", count = 3) {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      title: `Company ${i}`,
      url: `https://example${i}.com/research`,
      ...(provider === "exa"
        ? { text: "This is a long evidence excerpt. ".repeat(6) }
        : { content: "This is a long evidence excerpt. ".repeat(6) }),
    })),
  };
}
/** Every catalog provider set to the same availability, for engine mocks. */
export function availability(value: boolean) {
  return Object.fromEntries(providerIds.map((p) => [p, value])) as Record<
    (typeof providerIds)[number],
    boolean
  >;
}
