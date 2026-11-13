import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  payment: {} as Record<string, unknown>,
  rpc: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: fixtures.payment, error: null }),
        update: (patch: Record<string, unknown>) => { fixtures.update(patch); return query; },
        in: async () => ({ error: null }),
      };
      return query;
    },
    rpc: fixtures.rpc,
  }),
}));
import { reconcileMpesa, requestStkPush, requireMpesaConfig } from "./mpesa";

function providerResult(result: Record<string, unknown>) {
  fixtures.fetch.mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
    .mockResolvedValueOnce(Response.json(result));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.fetch.mockReset();
  vi.stubGlobal("fetch", fixtures.fetch);
  for (const [key, value] of Object.entries({ MPESA_ENV: "sandbox", MPESA_CONSUMER_KEY: "test-key", MPESA_CONSUMER_SECRET: "test-secret", MPESA_SHORTCODE: "174379", MPESA_PASSKEY: "test-passkey", PAYMENT_TEST_FRANCHISE_ID: "demo", APP_URL: "https://autocare.example" })) vi.stubEnv(key, value);
  fixtures.payment = { id: "payment", reference: "PAY-test", status: "PROCESSING", franchise_id: "demo", is_test: true, mpesa_checkout_id: "checkout-test", provider_reference: "fingerprint", amount: "100.00", currency: "KES" };
  fixtures.rpc.mockImplementation(async () => { fixtures.payment.status = "SUCCEEDED"; return { error: null }; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("M-Pesa sandbox provider contract (mocked, no real payments)", () => {
  it("sends the sandbox STK request with the configured callback and amount", async () => {
    providerResult({ ResponseCode: "0", CheckoutRequestID: "checkout-test" });
    expect(await requestStkPush({ phone: "+254708374149", amount: 100, accountReference: "SANDBOX-INVOICE-123" })).toBe("checkout-test");
    const [url, options] = fixtures.fetch.mock.calls[1];
    expect(url).toBe("https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest");
    expect(JSON.parse(options.body)).toMatchObject({ Amount: 100, PhoneNumber: "254708374149", PartyB: "174379", CallBackURL: "https://autocare.example/api/payments/mpesa/callback", AccountReference: "SANDBOXINVOI", TransactionType: "CustomerPayBillOnline", TransactionDesc: "AutoCare test" });
  });
  it("settles authenticated success once, even when reconciliation is repeated", async () => {
    providerResult({ ResponseCode: "0", ResultCode: 0, CheckoutRequestID: "checkout-test" });
    expect(await reconcileMpesa("PAY-test")).toBe("SUCCEEDED");
    expect(await reconcileMpesa("PAY-test")).toBe("SUCCEEDED");
    expect(fixtures.rpc).toHaveBeenCalledTimes(1);
    expect(fixtures.rpc).toHaveBeenCalledWith("settle_verified_invoice_payment", { p_reference: "PAY-test", p_provider: "MPESA", p_provider_reference: "fingerprint", p_amount_minor: 10000, p_currency: "KES", p_is_test: true });
    expect(fixtures.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([1, 1032, 1037, 2001])("records failure %s without crediting the invoice", async (code) => {
    providerResult({ ResponseCode: "0", ResultCode: code, CheckoutRequestID: "checkout-test" });
    expect(await reconcileMpesa("PAY-test")).toBe("FAILED");
    expect(fixtures.update).toHaveBeenCalledWith({ status: "FAILED", failure_reason: `M-Pesa result ${code}` });
    expect(fixtures.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ResponseCode: "0", ResultCode: 0, CheckoutRequestID: "another-checkout" },
    { ResponseCode: "1", ResultCode: 0, CheckoutRequestID: "checkout-test" },
    { ResponseCode: "0", CheckoutRequestID: "checkout-test" },
    { ResponseCode: "0", ResultCode: 9999, CheckoutRequestID: "checkout-test" },
  ])("leaves unverified or unknown results pending", async (result) => {
    providerResult(result);
    expect(await reconcileMpesa("PAY-test")).toBe("PROCESSING");
    expect(fixtures.rpc).not.toHaveBeenCalled();
    expect(fixtures.update).not.toHaveBeenCalled();
  });
  it("does not settle or fail a payment when provider authentication is unavailable", async () => {
    fixtures.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(reconcileMpesa("PAY-test")).rejects.toThrow("authentication failed");
    expect(fixtures.rpc).not.toHaveBeenCalled();
    expect(fixtures.update).not.toHaveBeenCalled();
  });
  it("rejects live configuration and payments outside the demo garage", async () => {
    vi.stubEnv("MPESA_ENV", "production");
    expect(requireMpesaConfig).toThrow("sandbox is not configured");
    fixtures.payment.franchise_id = "real-garage";
    await expect(reconcileMpesa("PAY-test")).rejects.toThrow("demo garage");
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });
  it("reports only a safe provider error code and leaves uncertain payments unchanged", async () => {
    fixtures.fetch.mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
      .mockResolvedValueOnce(Response.json({ errorCode: "500.001.1001", errorMessage: "secret provider payload" }, { status: 500 }));
    await expect(reconcileMpesa("PAY-test")).rejects.toMatchObject({ code: "MPESA_PROVIDER_500.001.1001", message: expect.not.stringContaining("secret provider payload") });
    expect(fixtures.rpc).not.toHaveBeenCalled();
    expect(fixtures.update).not.toHaveBeenCalled();
  });
});
