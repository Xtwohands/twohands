export function testUsdc(units: number) {
  const whole = Math.floor(units / 1000000);
  const fraction = String(units % 1000000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ".00"}`;
}

/** Service credits in USD micros, keeping sub-cent usage visible. */
export function sandboxCredits(micros: number) {
  return `$${(micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

/** A signed wallet posting, such as "+$5.00" or "−$0.0077". */
export function creditChange(micros: number) {
  return `${micros < 0 ? "−" : "+"}${sandboxCredits(Math.abs(micros))}`;
}

const postingLabels: Record<string, string> = {
  deposit: "Card top-up",
  refund: "Refund to card",
  dispute_hold: "Payment dispute hold",
  dispute_release: "Dispute closed",
  usage: "Tool call",
  adjustment: "Adjustment by Two Hands",
};
export function postingLabel(kind: string) {
  return postingLabels[kind] ?? kind.replaceAll("_", " ");
}
