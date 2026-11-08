export const BASE_SEPOLIA = {
  chainId: 84532,
  chainName: "Base Sepolia",
  asset: "USDC",
  decimals: 6,
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  explorer: "https://sepolia.basescan.org",
} as const;
export interface DepositIntent {
  id: string;
  requestKey: string;
  amountUnits: number;
  sender: string;
  recipient: string;
  chainId: 84532;
  tokenAddress: string;
  status:
    | "awaiting_transfer"
    | "pending"
    | "awaiting_finality"
    | "credited"
    | "rejected"
    | "expired";
  createdAt: string;
  expiresAt: string;
  transactionHash: string | null;
  blockNumber: string | null;
  lastCheckedAt: string | null;
  creditedAt: string | null;
  message: string;
  verificationProof?: {
    blockHash: string;
    logIndex: string;
    finalizedBlockNumber: string;
    finalizedBlockHash: string;
  };
}
export interface FundingSummary {
  enabled: boolean;
  unavailableReason: string | null;
  network: typeof BASE_SEPOLIA;
  recipient: string | null;
  balanceUnits: number;
  totalDeposits: number;
  intents: DepositIntent[];
  testnet: true;
  spendableForProviders: false;
  onchainBalanceUnits?: number;
  onchainDeposits?: number;
  stripeDeposits?: number;
  stripe?: StripeFundingStatus;
  stripeIntents?: StripeDeposit[];
  entries?: FundingEntry[];
}
export interface FundingEntry {
  id: number;
  source: "onchain" | "stripe";
  sourceId: string;
  deltaUnits: number;
  kind: string;
  reference: string;
  createdAt: string;
}
export interface StripeFundingStatus {
  enabled: boolean;
  unavailableReason: string | null;
  mode: "test";
  minimumCents: number;
  maximumCents: number;
}
export interface StripeDeposit {
  id: string;
  requestKey: string;
  amountCents: number;
  status:
    | "creating"
    | "checkout_ready"
    | "processing"
    | "credited"
    | "partially_refunded"
    | "refunded"
    | "disputed"
    | "expired"
    | "failed";
  checkoutSessionId: string | null;
  checkoutUrl: string | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  refundedCents: number;
  disputed: boolean;
  netCreditUnits: number;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  message: string;
}
