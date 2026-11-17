export function testUsdc(units: number) {
  const whole = Math.floor(units / 1000000);
  const fraction = String(units % 1000000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ".00"}`;
}

/** Sandbox service credits in USD micros, keeping sub-cent usage visible. */
export function sandboxCredits(micros: number) {
  return `$${(micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}
