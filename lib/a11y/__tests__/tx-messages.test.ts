import { describe, expect, it } from "vitest";
import { announcementPoliteness, failureMessage, txMessages } from "../tx-messages";
import type { DescribedError } from "@/lib/stellar/errors";

const rejected: DescribedError = { kind: "rejected", message: "You cancelled the request in your wallet." };
const failed: DescribedError = { kind: "contract", code: "SlippageExceeded", message: "The price moved before your trade went through." };

describe("transaction announcements", () => {
  it("states the amount and never a hash", () => {
    const message = txMessages.confirmed({ action: "Buy YES shares", amount: 12_345_678n, unit: "shares" });
    expect(message).toContain("1.23");
    expect(message).toContain("shares");
    expect(message).toContain("Buy YES shares");
    expect(message).not.toMatch(/[0-9a-f]{16,}/i);
  });

  it("uses the cancellation copy when the user rejected", () => {
    const message = failureMessage("Buy YES shares", rejected);
    expect(message).toContain("cancelled");
    expect(message).toContain("Nothing was sent");
    expect(message).not.toBe(rejected.message);
  });

  it("keeps the plain message for every other failure", () => {
    const message = failureMessage("Buy YES shares", failed);
    expect(message).toBe(failed.message);
  });

  it("announces a rejection politely and everything else assertively", () => {
    expect(announcementPoliteness("rejected")).toBe("polite");
    expect(announcementPoliteness("contract")).toBe("assertive");
    expect(announcementPoliteness("network")).toBe("assertive");
    expect(announcementPoliteness("insufficient-balance")).toBe("assertive");
  });

  it("formats amounts from base units, never through a float", () => {
    // One base unit is 0.0000001 USDC; at two decimals it truncates to zero
    // rather than turning into 1e-7.
    expect(txMessages.confirmed({ action: "Pay", amount: 1n, unit: "USDC" })).toContain("0 USDC");
    // 10 USDC exactly (7 decimals).
    expect(txMessages.confirmed({ action: "Pay", amount: 100_000_000n, unit: "USDC" })).toContain("10 USDC");
    // A large amount keeps its grouping and does not lose precision.
    const large = txMessages.confirmed({ action: "Pay", amount: 10n ** 15n, unit: "USDC" });
    expect(large).toContain("100,000,000");
    expect(large).not.toContain("NaN");
    expect(large).not.toContain("Infinity");
    expect(large).not.toContain("e+");
    // Two decimals never round up.
    expect(txMessages.confirmed({ action: "Pay", amount: 1_999_999n, unit: "USDC" })).toContain("0.19");
  });

  it("says what is waiting for the user", () => {
    expect(txMessages.awaitingSignature("Buy YES shares")).toContain("wallet");
    expect(txMessages.awaitingSignature("Buy YES shares")).toContain("Buy YES shares");
    expect(txMessages.submitted("Buy YES shares")).toContain("network");
    expect(txMessages.backendFollowUp("Daily pass payment")).toContain("on-chain");
  });
});
