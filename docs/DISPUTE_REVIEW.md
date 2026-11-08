# Admin payment dispute review

The operator sidebar has **Payment disputes** at `#disputes`. It provides a review queue for Stripe test payments whose saved, server-verified Charge has been observed as disputed. The queue automatically includes existing disputed payment receipts, including those created before this feature.

This is an administrative review workflow. It records investigation status and notes while retaining credit holds. It does not submit evidence to Stripe, change a bank dispute outcome, issue refunds, or restore credits. **Reviewed · hold retained** means the local investigation was reviewed; it does not mean the Stripe dispute was resolved or won.

## Enable admin access

Configure a separate server credential and restart:

```dotenv
ADMIN_API_TOKEN=<a strong random admin-only credential>
```

The credential must be nonempty and different from `API_TOKEN`. Blank or identical credentials disable the admin funding API. The workspace bearer token cannot access admin funding routes, and the admin credential alone cannot access workspace routes when `API_TOKEN` is configured. Use HTTPS for remote access. Do not paste credentials into review notes or URLs.

Open Payment disputes and enter the admin credential. It stays in React memory while the page is mounted; it is not written to local/session storage or URLs. **Lock admin access**, leaving the page, or a rejected/disabled credential clears the open review and drafts. Delayed responses from an older login cannot reopen or lock a newer login.

Both deposit methods remain independently disabled until configured. Admin review can read historical disputes without enabling new deposits or provider spending. **Verify Stripe status** additionally requires the Stripe test verification credentials described in [Stripe setup](STRIPE_DEPOSITS.md); it uses the existing per-payment manual-check cooldown.

## Review workflow

1. Filter by Needs review, In review, or Reviewed; search receipt, payment/charge ID, or the latest note.
2. Open a payment to inspect its saved amount, refund total, net credits, provider verification time, payment and charge IDs, prior review, and audit history.
3. Refresh saved evidence, or explicitly verify the current payment state with Stripe.
4. Choose a local review status and enter a 10–4,000 character note describing the evidence checked and decision.
5. Save the review. The payment's credit hold remains unchanged. History records the previous/new status, note, evidence snapshot, server time, revision, and a server-derived admin-credential identifier.

Credential identifiers identify the credential used; they are not verified human identities. Shared credentials cannot distinguish individual people. Per-user admin accounts and roles remain separate production work.

Every save includes the current revision and a fingerprint of material payment evidence. If another admin saves first or the amount/payment identity/refund/dispute/credit state changes, a stale save returns `409`. Refresh the case before saving; the UI preserves the draft note. A later material evidence change reopens a reviewed case as Needs review. Merely refreshing a verification timestamp does not reopen it. Previous decisions remain in history.

Review saves use UUID idempotency keys. Retrying unchanged details after a lost response adds no duplicate decision. Reusing a key with different content or a different server-derived actor returns `409`. The review and its immutable audit evidence commit in one database transaction. Saving a local review does not change the financial ledger or underlying Stripe receipt. **Verify Stripe status** can update the saved receipt and ledger under the existing refund and dispute rules; it never releases a dispute hold.

## API

All routes below require `Authorization: Bearer <ADMIN_API_TOKEN>`. Mutating routes require JSON and enforce same-origin writes. The admin router has its own authentication boundary before the general workspace-token middleware. Unknown routes inside this prefix remain behind admin authentication.

| Method | Route                                              | Behavior                                                                                                                |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin/funding/disputes?status=all&q=&page=1` | Filtered queue, 25 cases per page, total matches, and global review-status counts.                                      |
| GET    | `/api/admin/funding/disputes/:id`                  | Current saved payment, local review, evidence fingerprint, and latest 100 immutable review events.                      |
| POST   | `/api/admin/funding/disputes/:id/review`           | Save `{requestKey, revision, evidenceFingerprint, status, note}`. Status is `needs_review`, `in_review`, or `reviewed`. |
| POST   | `/api/admin/funding/disputes/:id/recheck`          | Verify the saved payment with Stripe, then return current review detail; body `{}`.                                     |

The queue is one case per disputed payment, not an inventory of individual Stripe dispute objects. Bank-dispute reason codes, response deadlines, document uploads, evidence submission, and credit restoration are not implemented in this checkpoint. Inspect Stripe directly for those operations. Notes and audit evidence are stored in funding-only tables and excluded from provider/model statistics and commercial observation exports.

## Event ordering and tests

A refund/dispute event can arrive before Checkout completion has populated saved charge/payment IDs. For unmatched charge events with a PaymentIntent ID, the server retrieves that test PaymentIntent and uses its own deposit metadata to locate a candidate. It then performs the existing full saved Checkout/payment/capture validation before changing credits. Metadata alone cannot authorize a credit. Retrieval failures are not acknowledged as processed, allowing Stripe to retry.

Unit coverage includes historical queue discovery, exact admin/workspace credential separation, fail-closed configuration, origin/schema checks, atomic notes/audit rollback, immutable evidence, stale review/evidence conflicts, idempotent replay, meaningful-evidence reopening, and retained credit holds. Browser coverage exercises desktop/mobile review flows, conflict recovery, locking, disabled defaults, rejected credentials, and old-response isolation. Payment evidence and webhook deliveries in tests are isolated fixtures; no actual payment or transfer was made.
