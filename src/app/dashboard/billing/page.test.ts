import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  state: vi.fn(),
  request: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: EffectCallback) => fixture.effects.push(effect),
  useState: (initial: unknown) => [initial, fixture.state],
}));
vi.mock("@/lib/client-cache", () => ({ request: fixture.request }));

import BillingPage from "./page";
import { WorkspaceContext } from "@/components/workspace-context";

const reference = `SUB-${"a".repeat(32)}`;
const summaryUrl = "/api/billing/summary?franchiseId=garage-a";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.effects = [];
  vi.stubGlobal("window", {
    location: { search: `?paystack_reference=${reference}` },
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  [202, { paid: false }, "Subscription payment is still processing.", 1],
  [200, { paid: true }, "Subscription payment confirmed.", 2],
  [200, { paid: false }, "Subscription payment could not be confirmed yet.", 1],
  [200, null, "Subscription payment could not be confirmed yet.", 1],
  [500, { paid: true }, "Subscription payment could not be confirmed yet.", 1],
])(
  "shows the Paystack subscription outcome for HTTP %i and payload %j",
  async (http, payload, message, summaryRequests) => {
    fixture.request.mockImplementation(async (url: string) =>
      url === `/api/payments/paystack/verify?reference=${reference}`
        ? Response.json(payload, { status: http })
        : Response.json({ banks: [] }),
    );
    renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        {
          value: {
            userId: "owner-a",
            garage: true,
            role: "FRANCHISE_OWNER",
            franchiseId: "garage-a",
          },
        },
        createElement(BillingPage),
      ),
    );
    for (const effect of fixture.effects) effect();
    await vi.waitFor(() => expect(fixture.state).toHaveBeenCalledWith(message));
    expect(fixture.request.mock.calls.filter(([url]) => url === summaryUrl))
      .toHaveLength(summaryRequests);
  },
);
