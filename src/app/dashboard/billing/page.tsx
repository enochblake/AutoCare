"use client";

import { request } from "@/lib/client-cache";

import { useEffect, useState, type FormEvent } from "react";
import { useWorkspace } from "@/components/workspace-context";

type Bank = { name: string; code: string };
type BillingSummary = {
  franchise: { id: string; name: string; status: string; payoutsConnected: boolean };
  subscription: { trial_ends_at: string | null; current_period_ends_at: string; paystack_status: string | null; paystack_subscription_code: string | null; plan: { name: string; monthly_price: string } };
  paystackConfigured: boolean;
  planConfigured: boolean;
};

export default function BillingPage() {
  const { franchiseId, role } = useWorkspace();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function load(id: string) {
    const response = await request(`/api/billing/summary?franchiseId=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Billing details could not be loaded");
    setSummary(await response.json());
  }

  useEffect(() => {
    void (async () => {
      try {
        if (role !== "FRANCHISE_OWNER" || !franchiseId) throw new Error("Only a garage owner can manage billing");
        await Promise.all([
          load(franchiseId),
          request("/api/billing/banks").then(async response => {
            if (response.ok) setBanks((await response.json()).banks);
          }),
        ]);
        const reference = new URLSearchParams(window.location.search).get("paystack_reference");
        if (reference?.startsWith("SUB-")) {
          const verify = await request(`/api/payments/paystack/verify?reference=${encodeURIComponent(reference)}`);
          if (verify.status === 202) {
            setMessage("Subscription payment is still processing.");
          } else if (verify.ok && (await verify.json().catch(() => null))?.paid === true) {
            setMessage("Subscription payment confirmed.");
            await load(franchiseId);
          } else {
            setMessage("Subscription payment could not be confirmed yet.");
          }
        }
      } catch (error) { setMessage(error instanceof Error ? error.message : "Billing could not be loaded"); }
    })();
  }, [franchiseId, role]);

  async function connectPayouts(event: FormEvent) {
    event.preventDefault(); if (!franchiseId) return;
    setBusy(true); setMessage("");
    try {
      const response = await request("/api/billing/subaccount", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ franchiseId, bankCode, accountNumber }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Payouts could not be connected");
      setAccountNumber(""); setMessage("Garage payouts are connected."); await load(franchiseId);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Payouts could not be connected"); }
    finally { setBusy(false); }
  }

  async function subscribe() {
    if (!franchiseId) return;
    setBusy(true); setMessage("");
    try {
      const response = await request("/api/billing/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ franchiseId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Subscription checkout could not be started");
      window.location.assign(result.checkoutUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Subscription checkout could not be started"); setBusy(false); }
  }

  return <div className="app-content">
    <div className="welcome"><div><h2>Billing & payouts</h2><p>Manage your garage subscription and where customer payments settle.</p></div></div>
    {message && <p role="status" style={{ padding: "12px 0" }}>{message}</p>}
    {summary && <div className="panel-grid">
      <section className="panel"><div className="panel-head"><h3>AutoCare subscription</h3></div><div style={{ padding: 20 }}>
        <p><strong>{summary.subscription.plan.name}</strong> · KES {Number(summary.subscription.plan.monthly_price).toLocaleString()} per month</p>
        <p>Garage status: {summary.franchise.status.replaceAll("_", " ")}</p>
        {summary.franchise.status === "TRIAL" && summary.subscription.trial_ends_at && <p>Trial ends {new Date(summary.subscription.trial_ends_at).toLocaleDateString("en-KE")}.</p>}
        {summary.subscription.paystack_status === "active" && !summary.subscription.paystack_subscription_code ? <p>First payment confirmed. Waiting for Paystack to confirm monthly renewal.</p> : null}
        {summary.subscription.paystack_subscription_code && (summary.subscription.paystack_status === "active" || summary.subscription.paystack_status === "non-renewing") ? <p>Paystack subscription: {summary.subscription.paystack_status}</p> : null}
        {!summary.subscription.paystack_subscription_code && summary.subscription.paystack_status !== "active" && <p>The first month is charged when you subscribe. Future months renew by card.</p>}
        {!summary.subscription.paystack_subscription_code && summary.subscription.paystack_status !== "active" && <button className="btn btn-primary" disabled={busy || !summary.paystackConfigured || !summary.planConfigured} onClick={() => void subscribe()}>{busy ? "Opening…" : summary.subscription.paystack_status === "pending" ? "Resume Paystack checkout" : "Subscribe with Paystack"}</button>}
        {summary.subscription.paystack_subscription_code && summary.subscription.paystack_status !== "active" && summary.subscription.paystack_status !== "non-renewing" && <p>Subscription status: {summary.subscription.paystack_status}. Contact AutoCare to restart billing.</p>}
        {(!summary.paystackConfigured || !summary.planConfigured) && <p>Paystack billing is awaiting platform setup.</p>}
      </div></section>
      <section className="panel"><div className="panel-head"><h3>Customer payment payouts</h3></div><div style={{ padding: 20 }}>
        {summary.franchise.payoutsConnected ? <p>Your garage payout account is connected. Customer invoice payments can settle to it.</p> :
          <form onSubmit={(event) => void connectPayouts(event)} style={{ display: "grid", gap: 14 }}>
            <p>Connect a Kenyan payout account before customers pay invoices online.</p>
            <div className="field"><label htmlFor="bank">Bank</label><select id="bank" className="input" value={bankCode} onChange={(event) => setBankCode(event.target.value)} required><option value="">Select a bank</option>{banks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}</select></div>
            <div className="field"><label htmlFor="account">Account number</label><input id="account" className="input" inputMode="numeric" autoComplete="off" pattern="[0-9]{6,20}" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} required /></div>
            <button className="btn btn-primary" disabled={busy || !summary.paystackConfigured || !banks.length}>{busy ? "Connecting…" : "Connect payouts"}</button>
            <small>Check the bank and account number carefully. AutoCare does not store your account number.</small>
          </form>}
      </div></section>
    </div>}
  </div>;
}
