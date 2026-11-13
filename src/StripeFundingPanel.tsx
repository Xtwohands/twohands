import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  RefreshCw01,
} from "@untitledui/icons";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { api } from "./api";
import { CopyButton, Empty, InlineError, date } from "./observation-ui";
import type { FundingSummary, StripeDeposit } from "../server/funding-types";

const labels: Record<StripeDeposit["status"], string> = {
  creating: "Preparing checkout",
  checkout_ready: "Awaiting payment",
  processing: "Processing",
  credited: "Credited",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  disputed: "Dispute hold",
  expired: "Expired",
  failed: "Needs attention",
};
const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export function StripeFundingPanel({
  summary,
  refresh,
}: {
  summary?: FundingSummary;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<StripeDeposit>();
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [returned, setReturned] = useState(false);
  const key = useRef(crypto.randomUUID());
  const handledReturn = useRef(false);
  useEffect(() => {
    const current = summary?.stripeIntents?.find((i) => i.id === selected?.id);
    if (current) setSelected(current);
  }, [summary?.stripeIntents, selected?.id]);
  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;
    const query = new URLSearchParams(location.search);
    const id = query.get("stripe_deposit");
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return;
    setReturned(true);
    setOpen(true);
    setBusy(true);
    // A return URL only opens a saved receipt. It never proves payment or adds credits.
    void api<StripeDeposit>(`/workspace/funding/stripe/${id}`)
      .then(setSelected)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
    query.delete("stripe_deposit");
    query.delete("stripe_cancelled");
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${query.size ? `?${query}` : ""}${location.hash}`,
    );
  }, []);
  async function prepare(retry?: StripeDeposit) {
    setBusy(true);
    setError("");
    try {
      const result = await api<StripeDeposit>("/workspace/funding/stripe", {
        requestKey: retry?.requestKey ?? key.current,
        amount: retry ? (retry.amountCents / 100).toFixed(2) : amount,
      });
      setSelected(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="ws-panel ws-funding-method" id="stripe-deposits">
        <header>
          <div>
            <h2>Card via Stripe</h2>
            <p>Hosted Checkout · USD test payments</p>
          </div>
          <Badge variant="outline">
            {summary?.stripe?.enabled ? "Available" : "Unavailable"}
          </Badge>
        </header>
        <div>
          <p>
            {summary?.stripe?.enabled
              ? "Complete a test payment on Stripe’s secure checkout. Each verified test dollar adds one test credit. Refunds and disputed payments adjust the credit balance."
              : "Card payments are not available yet. There is nothing to configure in your account."}
          </p>
          {!summary?.stripe?.enabled && (
            <div className="ws-funding-setup">
              <strong>Card deposits are unavailable</strong>
              <p>
                You can continue setting up your agent without a payment method.
                No card details are needed.
              </p>
            </div>
          )}
          <Button
            disabled={!summary?.stripe?.enabled}
            onClick={() => {
              setSelected(undefined);
              setError("");
              setReturned(false);
              key.current = crypto.randomUUID();
              setOpen(true);
            }}
          >
            Deposit with Stripe
            <ArrowRight />
          </Button>
        </div>
      </section>
      {(summary?.stripe?.enabled || !!summary?.stripeIntents?.length) && (
        <section className="ws-panel">
          <header>
            <div>
              <h2>Card deposit history</h2>
              <p>Test payments and their current credit adjustments.</p>
            </div>
            <Badge variant="outline">Test mode</Badge>
          </header>
          {summary?.stripeIntents?.length ? (
            <div
              className="ws-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Card deposit history"
            >
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Net credits</th>
                    <th>
                      <span className="sr-only">Inspect</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.stripeIntents.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{usd(i.amountCents)}</strong> test USD
                      </td>
                      <td>{labels[i.status]}</td>
                      <td>{date(i.createdAt)}</td>
                      <td>
                        {(i.netCreditUnits / 1e6).toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelected(i);
                            setError("");
                            setReturned(false);
                            setOpen(true);
                          }}
                        >
                          View card deposit
                          <ArrowRight />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No card deposits yet">
              Verified Stripe test payments will appear here.
            </Empty>
          )}
        </section>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="ws-detail-dialog customer-funding-dialog translate-x-0 translate-y-0">
          <DialogHeader>
            <DialogTitle>
              {selected ? "Card deposit details" : "Deposit with Stripe"}
            </DialogTitle>
            <DialogDescription>
              Stripe test mode. Test credits cannot pay for live tool calls.
            </DialogDescription>
          </DialogHeader>
          <InlineError message={error} />
          {returned && (
            <p className="ws-panel-note">
              Returned from Checkout. Only Stripe’s verified payment status can
              add credits; returning or cancelling does not confirm a payment.
            </p>
          )}
          {selected ? (
            <div className="ws-deposit-detail">
              <div className="ws-deposit-state">
                <CheckCircle />
                <div>
                  <strong>{labels[selected.status]}</strong>
                  <p>{selected.message}</p>
                </div>
              </div>
              <div className="ws-detail-facts">
                <div>
                  <span>Requested payment</span>
                  <strong>{usd(selected.amountCents)} test USD</strong>
                </div>
                <div>
                  <span>Net test credits</span>
                  <strong>{(selected.netCreditUnits / 1e6).toFixed(2)}</strong>
                </div>
                <div>
                  <span>Refund reported</span>
                  <strong>{usd(selected.refundedCents)}</strong>
                </div>
                <div>
                  <span>Last verified</span>
                  <strong>
                    {selected.lastCheckedAt
                      ? date(selected.lastCheckedAt)
                      : "Not checked"}
                  </strong>
                </div>
              </div>
              <div className="ws-receipt-id">
                <code>{selected.id}</code>
                <CopyButton text={selected.id} />
              </div>
              {selected.checkoutUrl && selected.status === "checkout_ready" && (
                <Button asChild>
                  <a
                    href={selected.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Continue to Stripe
                    <ArrowUpRight />
                  </a>
                </Button>
              )}
              {!selected.checkoutSessionId ? (
                <Button
                  disabled={busy || !summary?.stripe?.enabled}
                  onClick={() => void prepare(selected)}
                >
                  {busy ? "Preparing checkout…" : "Retry checkout"}
                  <RefreshCw01 />
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      setSelected(
                        await api<StripeDeposit>(
                          `/workspace/funding/stripe/${selected.id}/reconcile`,
                          {},
                        ),
                      );
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Checking payment…" : "Check payment status"}
                  <RefreshCw01 />
                </Button>
              )}
              <p className="field-hint">
                Credits post once after server verification. If a payment is
                refunded or disputed, this receipt and the credit ledger retain
                the adjustment.
              </p>
            </div>
          ) : busy ? (
            <p role="status">Loading saved deposit…</p>
          ) : (
            <form
              className="ws-deposit-form"
              onSubmit={(e) => {
                e.preventDefault();
                void prepare();
              }}
            >
              <label>
                <span>Amount in test USD</span>
                <Input
                  aria-label="Card deposit amount"
                  inputMode="decimal"
                  required
                  value={amount}
                  disabled={busy}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    key.current = crypto.randomUUID();
                  }}
                />
                <small>$5–$1,000 · Up to two decimal places</small>
              </label>
              <p>
                Enter card details on Stripe. Two Hands never receives your card
                number.
              </p>
              <Button
                type="submit"
                disabled={busy || !summary?.stripe?.enabled}
              >
                Prepare checkout
                <ArrowRight />
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
