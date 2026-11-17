# Wallet enforcement (sandbox)

Phase 2 of the [prepaid usage billing PRD](PRODUCTION_WALLET_PRD.md). With `TWO_HANDS_WALLET_ENFORCEMENT=true`, an enrolled account's prepaid service-credit balance gates and pays for eligible hosted paid tool calls. Funding is Stripe **test mode** only: these are sandbox credits, no real money is accepted, and live-mode Stripe is a later phase. The flag is off by default, and with it off admission is unchanged.

## What is enforced

- **Billable configuration.** Only Tavily basic search with 10 maximum results on adapter version 1.0.0, for an account with an unexpired operator-verified rate in `octolab.wallet_rates`. Recording that rate is how an operator enrolls an account. The rate binds the provider account reference and a credential digest: SHA-256 over `two-hands-wallet-tavily-v1`, a NUL byte, and the exact credential, computed inside the secret-handling environment. Never export the credential or its digest. A key rotation or adapter change requires re-verification. The runtime cannot enroll an account, set a rate, or post credit adjustments.
- **Everything else is unchanged.** Other tools, advanced search, accounts without an active rate, and an enrolled account whose rate expired or whose credential rotated are not held or charged. They continue under the operator allowance, key caps and session caps exactly as before. Let a rate lapse only deliberately: the account's Tavily calls then run uncharged under its allowance.
- **Separate controls.** A call still needs the [operator allowance](WORKSPACE_ALLOWANCES.md), its key cap and its session budget. A top-up never grants or raises an allowance; an operator provisions the allowance at onboarding. A denial by any control reserves nothing in the others.
- **Entry points.** Direct calls and routed attempts on the canonical observation path pass through wallet admission, for scoped keys and signed-in sessions alike. Legacy tasks, the provider lab, SQLite and demo traffic keep their existing operator-funded accounting and never touch the wallet.

## Call lifecycle

1. **Reserve.** In the workspace transaction that writes the call receipt, the server freezes the rate, locks the account's balance row, and inserts a hold of the provider cost × 110% rounded up to the next USD micro. Available credits are posted balance minus open holds. All keys and sessions of an account serialize on the workspace lock, so concurrent calls cannot reserve beyond one balance.
2. **Deny.** If available credits are below the hold, or a payment dispute is unresolved, the transaction rolls back before any provider I/O. HTTP callers receive `402` with `{error, code:"insufficient_credits", wallet:{reason, requiredMicros, availableMicros, heldMicros}}`, where `reason` is `insufficient_balance` or `dispute_hold`. MCP hosts see the message with the `[insufficient_credits]` code. Agents can continue with free tools; consumers are never asked to manage funding.
3. **Settle.** The saved result, hold closure and debit commit in one transaction. A succeeded call posts one debit of the frozen cost plus 10% (markup rounded to the nearest micro, ties up) and releases the remainder. A valid zero-result response is billable. A verified cost of zero posts a zero charge.
4. **Release.** A failed call, an interrupted call settled by startup recovery, or a response whose reported credit quantity contradicts the frozen rate (`cost_conflict`) closes the hold and charges zero. A hold admitted before the flag or rate was turned off still settles.
5. **Replay.** The same request key returns the saved call without another hold, dispatch or debit. A changed payload under the same key is rejected. The journal's primary key allows one usage posting per call.

## Funding

A Stripe sandbox checkout intent created while the flag is on, for an account with an active rate, is enrolled in `wallet_deposits` in the transaction that saves the intent. Earlier deposits and the existing test-credit balance are never backfilled, and the test-credit ledger keeps its own behavior. After the existing test-mode payment verification, the wallet converges on the deposit's verified net amount: webhook retries post once, refunds append negative entries, and a dispute appends a `dispute_hold` that removes the payment's remaining credits and freezes paid admission. If a reversal exceeds unused credits the posted balance goes negative, which also blocks admission. Only an operator can lift a dispute freeze, by appending a `dispute_release` entry for that deposit after review.

## Tables

All are private to the `octolab` schema, row-level-security scoped to the workspace, and independent of research retention.

| Table                  | Purpose                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `wallet_rates`         | Operator-verified rate and enrollment. Runtime read-only.                                                                     |
| `wallet_holds`         | One immutable hold per admitted call with the frozen rate, cost, markup and maximum.                                          |
| `wallet_hold_closures` | One explicit outcome per hold: `posted`, `failed`, `interrupted` or `cost_conflict`.                                          |
| `wallet_deposits`      | Checkout intents enrolled at creation.                                                                                        |
| `wallet_journal`       | Append-only postings: `deposit`, `refund`, `dispute_hold`, `usage`, and operator-only `dispute_release` and `adjustment`.     |
| `wallet_balances`      | Projection of posted and held micros, maintained by triggers in the same transaction as each journal, hold or closure insert. |

Each journal row carries both sides of the posting (`wallet_micros` and the opposite `clearing_micros`). Foreign keys tie a usage posting to a `posted` closure and to the hold's exact total, so an altered amount or a debit without a billable result cannot be stored. The runtime role can insert but not update or delete journal rows.

`SELECT octolab.wallet_rebuild_balances()` rebuilds every projection row from the journal and open holds; it changes nothing when the projection is already correct. Backup evidence reports `walletValid`, which fails when a posted closure lacks its debit, a finished call still has an open hold, an enrolled deposit's journal differs from its verified net credits, or the projection differs from a rebuild.

## Rollout

1. Apply migration `20261117120000_wallet_enforcement.sql` with the existing release procedure. It only adds tables, functions and policies.
2. Keep `TWO_HANDS_WALLET_ENFORCEMENT=false` until an operator has provisioned the pilot account's allowance and recorded its verified rate.
3. Enable the flag, make a new Stripe sandbox top-up, and run the drill: successful call, provider failure, replay, partial refund and dispute.
4. To pause, set the flag to `false`. New calls stop being held or charged; open holds, refunds and disputes for enrolled deposits continue to reconcile.

Credits (`#dashboard/credits`) shows **Available credits**, **Held for in-progress calls** and **Charged for tool calls** for an enforced account, from the `wallet` object on `GET /api/account/funding`.

## Not in this phase

Live-mode Stripe, customer statement export, quotes that include wallet eligibility in discovery, a bounded recovery window for unresolved holds beyond startup recovery, an operator interface for adjustments and dispute release, and requested unused-balance refunds.

## Validation

`tests/wallet.test.ts` covers the default-off flag, the structured denial before dispatch, hold and single debit with replay after a lost response, concurrent holds from two keys against one balance, in-flight holds, failure and interruption release, zero-cost and sub-cent rounding, verified deposit, refund and dispute, the separate operator allowance, unrated calls, neighbouring-account isolation, runtime posting restrictions, and projection rebuild. PostgreSQL cases need a disposable loopback database in `OCTOLAB_TEST_POSTGRES_URL` and use injected provider and Stripe fixtures only. Never run them, fixture credits or test grants against the hosted project.
