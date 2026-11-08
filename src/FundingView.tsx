import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Plus,
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
import type { DepositIntent, FundingSummary } from "../server/funding-types";

export function testUsdc(units: number) {
  const whole = Math.floor(units / 1000000);
  const fraction = String(units % 1000000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ".00"}`;
}
const statuses: Record<DepositIntent["status"], string> = {
  awaiting_transfer: "Awaiting transfer",
  pending: "Pending",
  awaiting_finality: "Awaiting finality",
  credited: "Credited",
  rejected: "Needs attention",
  expired: "Window expired",
};

export function FundingView() {
  const [summary, setSummary] = useState<FundingSummary>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [amount, setAmount] = useState("10");
  const [sender, setSender] = useState("");
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const key = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const selected = summary?.intents.find((i) => i.id === selectedId);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    try {
      const data = await api<FundingSummary>("/workspace/funding");
      if (generation.current === id) {
        setSummary(data);
        setError("");
      }
    } catch (e) {
      if (generation.current === id) setError((e as Error).message);
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  function show(intent: DepositIntent) {
    setSelectedId(intent.id);
    setHash(intent.transactionHash ?? "");
    setFormError("");
    setOpen(true);
  }
  const instructions = summary?.network;
  return (
    <div className="ws-funding">
      <InlineError message={error} />
      <div className="ws-funding-notice">
        <Badge variant="outline">Testnet only</Badge>
        <p>
          Base Sepolia USDC has no financial value. Test credits do not pay for
          live tool calls. Mainnet deposits are not supported.
        </p>
      </div>
      {loading ? (
        <div className="ws-loading" role="status">
          Loading deposit history…
        </div>
      ) : (
        <>
          <div className="ws-funding-grid">
            <section className="ws-panel ws-balance-card">
              <span>Workspace test balance</span>
              <strong>
                {summary ? testUsdc(summary.balanceUnits) : "—"}
                <small>test USDC</small>
              </strong>
              <p>
                {summary?.totalDeposits ?? 0} verified deposits · Separate from
                estimated tool usage
              </p>
              <Button
                disabled={!summary?.enabled}
                onClick={() => {
                  key.current = crypto.randomUUID();
                  setSelectedId(undefined);
                  setFormError("");
                  setOpen(true);
                }}
              >
                <Plus />
                Add test credits
              </Button>
            </section>
            <section className="ws-panel ws-funding-method">
              <header>
                <div>
                  <h2>USDC on Base Sepolia</h2>
                  <p>Verified on-chain deposits</p>
                </div>
                <Badge variant="outline">
                  {summary?.enabled ? "Available" : "Setup required"}
                </Badge>
              </header>
              <div>
                <p>
                  Send an exact amount from your wallet, submit the transaction
                  hash, and check its status. Test credits are added once the
                  matching transfer reaches the network’s finalized block.
                </p>
                {!summary?.enabled && (
                  <div className="ws-funding-setup">
                    <strong>
                      {summary?.unavailableReason ||
                        "Deposit service unavailable"}
                    </strong>
                    <p>
                      Configure a receiving address you control and enable
                      testnet deposits on the server.
                    </p>
                    <code>
                      DEPOSITS_TESTNET_ENABLED=true
                      <br />
                      BASE_SEPOLIA_DEPOSIT_ADDRESS=&lt;public address&gt;
                    </code>
                  </div>
                )}
                <a
                  href="https://faucet.circle.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get test USDC
                  <ArrowUpRight size={14} />
                </a>
              </div>
            </section>
          </div>
          <section className="ws-panel">
            <header>
              <div>
                <h2>Deposit history</h2>
                <p>
                  Saved requests and verified test credits in this workspace.
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh deposits"
                onClick={() => void refresh()}
              >
                <RefreshCw01 />
              </Button>
            </header>
            {summary?.intents.length ? (
              <div
                className="ws-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Deposit history"
              >
                <table className="ws-table">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Network</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th>Receipt</th>
                      <th>
                        <span className="sr-only">Inspect</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.intents.map((intent) => (
                      <tr key={intent.id}>
                        <td>
                          <strong>{testUsdc(intent.amountUnits)}</strong> test
                          USDC
                        </td>
                        <td>Base Sepolia</td>
                        <td>
                          <span
                            className={`ws-status ws-status-${intent.status === "credited" ? "succeeded" : intent.status === "rejected" ? "failed" : "running"}`}
                          >
                            <span />
                            {statuses[intent.status]}
                          </span>
                        </td>
                        <td>{date(intent.createdAt)}</td>
                        <td>
                          {intent.transactionHash ? (
                            <a
                              className="ws-text-link"
                              href={`${instructions?.explorer}/tx/${intent.transactionHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {intent.transactionHash.slice(0, 8)}…
                              {intent.transactionHash.slice(-6)}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : (
                            "Awaiting transaction"
                          )}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => show(intent)}
                          >
                            View deposit
                            <ArrowRight />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No deposits yet">
                Create a test deposit request to validate the funding flow on
                Base Sepolia.
              </Empty>
            )}
            <div className="ws-panel-note">
              Each on-chain transaction can be credited once. Request retries
              reuse the original receipt.
            </div>
          </section>
          <section className="ws-panel">
            <header>
              <div>
                <h2>Network details</h2>
                <p>Only this network and USDC contract are accepted.</p>
              </div>
            </header>
            <div className="ws-funding-details">
              <div>
                <span>Network</span>
                <strong>Base Sepolia · Chain ID {instructions?.chainId}</strong>
              </div>
              <div>
                <span>Token contract</span>
                <code>{instructions?.tokenAddress}</code>
                {instructions && (
                  <CopyButton text={instructions.tokenAddress} />
                )}
              </div>
              <div>
                <span>Receiving address</span>
                <code>{summary?.recipient ?? "Not configured"}</code>
                {summary?.recipient && <CopyButton text={summary.recipient} />}
              </div>
              <div>
                <span>Verification</span>
                <strong>
                  Successful USDC transfer, matching wallet and amount,
                  canonical block, and network finality
                </strong>
              </div>
            </div>
          </section>
        </>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="ws-detail-dialog translate-x-0 translate-y-0">
          <DialogHeader>
            <DialogTitle>
              {selectedId ? "Test deposit details" : "Add test credits"}
            </DialogTitle>
            <DialogDescription>
              USDC on Base Sepolia only. These tokens have no financial value.
            </DialogDescription>
          </DialogHeader>
          <InlineError message={formError} />
          {!selectedId ? (
            <form
              className="ws-deposit-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setFormError("");
                try {
                  const intent = await api<DepositIntent>(
                    "/workspace/funding/deposits",
                    { requestKey: key.current, amount, sender },
                  );
                  await refresh();
                  setSelectedId(intent.id);
                  setHash("");
                } catch (e) {
                  setFormError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                <span>Amount in test USDC</span>
                <Input
                  aria-label="Deposit amount"
                  inputMode="decimal"
                  value={amount}
                  required
                  disabled={busy}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    key.current = crypto.randomUUID();
                  }}
                />
                <small>1–1,000 test USDC · Up to six decimal places</small>
              </label>
              <label>
                <span>Sending wallet address</span>
                <Input
                  aria-label="Sending wallet address"
                  placeholder="0x…"
                  value={sender}
                  required
                  minLength={42}
                  maxLength={42}
                  disabled={busy}
                  onChange={(e) => {
                    setSender(e.target.value);
                    key.current = crypto.randomUUID();
                  }}
                />
                <small>Public address of the wallet sending the USDC.</small>
              </label>
              <Button type="submit" disabled={busy || !summary?.enabled}>
                {busy ? "Creating request…" : "Create deposit request"}
                <ArrowRight />
              </Button>
            </form>
          ) : selected ? (
            <div className="ws-deposit-detail">
              <div className="ws-deposit-state">
                {selected.status === "credited" ? <CheckCircle /> : <Clock />}
                <div>
                  <strong>{statuses[selected.status]}</strong>
                  <p>{selected.message}</p>
                </div>
              </div>
              <div className="ws-detail-facts">
                <div>
                  <span>Exact amount</span>
                  <strong>{testUsdc(selected.amountUnits)} test USDC</strong>
                </div>
                <div>
                  <span>Transfer window ends</span>
                  <strong>{date(selected.expiresAt)}</strong>
                </div>
              </div>
              <h3>Send test USDC to this address</h3>
              <div className="ws-receipt-id">
                <code>{selected.recipient}</code>
                <CopyButton text={selected.recipient} />
              </div>
              <p>
                Use Base Sepolia and the exact amount above. Send from{" "}
                <code className="ws-wrap-address">{selected.sender}</code>.
                You’ll need test ETH for gas. octolab does not sign or send the
                transfer.
              </p>
              {selected.status !== "credited" ? (
                <form
                  className="ws-deposit-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setBusy(true);
                    setFormError("");
                    try {
                      await api<DepositIntent>(
                        `/workspace/funding/deposits/${selected.id}/verify`,
                        { transactionHash: hash },
                      );
                      await refresh();
                    } catch (e) {
                      setFormError((e as Error).message);
                      await refresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label>
                    <span>Transaction hash</span>
                    <Input
                      aria-label="Deposit transaction hash"
                      placeholder="0x…"
                      minLength={66}
                      maxLength={66}
                      value={hash}
                      required
                      disabled={busy}
                      onChange={(e) => setHash(e.target.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    disabled={busy || !hash.trim() || !summary?.enabled}
                  >
                    {busy
                      ? "Verifying…"
                      : selected.transactionHash
                        ? "Check transaction again"
                        : "Verify transaction"}
                    <RefreshCw01 />
                  </Button>
                  <p className="field-hint">
                    Transfers must be mined within the 30-minute request window.
                    Finality may take longer; you can verify the same transfer
                    afterward.
                  </p>
                </form>
              ) : (
                <>
                  <div className="ws-funding-success">
                    <CheckCircle />
                    {testUsdc(selected.amountUnits)} test USDC added to the
                    workspace.
                  </div>
                  <a
                    className="ws-text-link"
                    href={`${instructions?.explorer}/tx/${selected.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Base Sepolia explorer
                    <ArrowUpRight />
                  </a>
                </>
              )}
              <div className="ws-panel-note">
                Request <code>{selected.id}</code>
              </div>
            </div>
          ) : (
            <div role="status">Loading deposit request…</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
