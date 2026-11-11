import "server-only";
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSandboxGarage, paymentAppUrl } from "./settings";

export function requireMpesaConfig() {
  const {
    MPESA_CONSUMER_KEY: key,
    MPESA_CONSUMER_SECRET: secret,
    MPESA_SHORTCODE: shortcode,
    MPESA_PASSKEY: passkey,
  } = process.env;
  if (
    process.env.MPESA_ENV !== "sandbox" ||
    !key ||
    !secret ||
    !shortcode ||
    !passkey
  )
    throw new ApiError(
      503,
      "M-Pesa sandbox is not configured",
      "PAYMENT_PROVIDER_UNAVAILABLE",
    );
  paymentAppUrl();
  return {
    key,
    secret,
    shortcode,
    passkey,
    base: "https://sandbox.safaricom.co.ke",
  };
}

async function providerRequest(path: string, body: Record<string, unknown>) {
  const config = requireMpesaConfig();
  const tokenResponse = await fetch(
    `${config.base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    },
  );
  if (!tokenResponse.ok)
    throw new ApiError(502, "M-Pesa authentication failed");
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token)
    throw new ApiError(502, "M-Pesa authentication failed");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const stamp = ["year", "month", "day", "hour", "minute", "second"]
    .map((type) => parts.find((p) => p.type === type)?.value)
    .join("");
  const response = await fetch(`${config.base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: Buffer.from(
        `${config.shortcode}${config.passkey}${stamp}`,
      ).toString("base64"),
      Timestamp: stamp,
      ...body,
    }),
  });
  if (!response.ok)
    throw new ApiError(
      502,
      "M-Pesa request could not be confirmed. Check payment status before trying again.",
    );
  return (await response.json()) as {
    CheckoutRequestID?: string;
    MerchantRequestID?: string;
    ResponseCode?: string;
    ResultCode?: string | number;
  };
}

export async function requestStkPush(input: {
  phone: string;
  amount: number;
  accountReference: string;
}) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new ApiError(400, "M-Pesa requires a whole KES amount");
  const { shortcode } = requireMpesaConfig();
  const result = await providerRequest("/mpesa/stkpush/v1/processrequest", {
    TransactionType: "CustomerPayBillOnline",
    Amount: input.amount,
    PartyA: input.phone.replace("+", ""),
    PartyB: shortcode,
    PhoneNumber: input.phone.replace("+", ""),
    CallBackURL: `${paymentAppUrl()}/api/payments/mpesa/callback`,
    AccountReference: input.accountReference.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "AutoCare",
    TransactionDesc: "AutoCare test",
  });
  if (String(result.ResponseCode) !== "0" || !result.CheckoutRequestID)
    throw new ApiError(502, "M-Pesa did not accept the request");
  return result.CheckoutRequestID;
}

export function callbackFingerprint(id: string) {
  return createHash("sha256").update(id).digest("hex");
}

export async function reconcileMpesa(reference: string) {
  const admin = createAdminClient();
  const found = await admin
    .from("payments")
    .select("*")
    .eq("reference", reference)
    .eq("provider", "MPESA")
    .single();
  if (found.error) throw found.error;
  const payment = found.data;
  assertSandboxGarage(payment.franchise_id);
  if (!payment.is_test)
    throw new ApiError(409, "This payment is not a sandbox payment");
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(payment.status))
    return payment.status as string;
  if (!payment.mpesa_checkout_id) return "PENDING";
  const result = await providerRequest("/mpesa/stkpushquery/v1/query", {
    CheckoutRequestID: payment.mpesa_checkout_id,
  });
  // A callback is only a hint: settle exclusively from Safaricom's authenticated query.
  if (
    result.CheckoutRequestID !== payment.mpesa_checkout_id ||
    String(result.ResponseCode) !== "0"
  )
    return "PROCESSING";
  if (String(result.ResultCode) === "0") {
    const settled = await admin.rpc("settle_verified_invoice_payment", {
      p_reference: payment.reference,
      p_provider: "MPESA",
      p_provider_reference: payment.provider_reference,
      p_amount_minor: Math.round(Number(payment.amount) * 100),
      p_currency: payment.currency,
      p_is_test: true,
    });
    if (settled.error) throw settled.error;
    return "SUCCEEDED";
  }
  if (["1", "1032", "1037", "2001"].includes(String(result.ResultCode))) {
    const updated = await admin
      .from("payments")
      .update({
        status: "FAILED",
        failure_reason: `M-Pesa result ${result.ResultCode}`,
      })
      .eq("id", payment.id)
      .in("status", ["PENDING", "PROCESSING"]);
    if (updated.error) throw updated.error;
    return "FAILED";
  }
  return "PROCESSING";
}
