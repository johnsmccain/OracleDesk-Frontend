/**
 * The announcement vocabulary for the transaction lifecycle.
 *
 * Every message is a complete sentence written for someone who cannot see
 * the screen. Amounts are formatted from bigint base units (never floats) and
 * a transaction hash is never part of the text: the hash belongs in the link,
 * where a screen reader can label it.
 */
import { formatUsdc } from "@/lib/stellar/units";
import type { DescribedError } from "@/lib/stellar/errors";

export type TxAnnouncementPhase =
  | "quoting"
  | "quoteReady"
  | "awaitingSignature"
  | "signatureRejected"
  | "submitted"
  | "confirmed"
  | "failed"
  | "backendFollowUp";

/** What the user is being asked to do, e.g. "Buy YES shares". */
export type TxAction = string;

export interface ConfirmedDetails {
  action: TxAction;
  amount: bigint;
  unit: "shares" | "USDC";
}

const amount = (value: bigint) => formatUsdc(value, { maxDecimals: 2, grouping: true });

export const txMessages = {
  /** A fresh quote is being fetched. */
  quoting: (action: TxAction) => `${action}: getting a fresh quote.`,

  /** The quote came back. */
  quoteReady: (details: ConfirmedDetails) =>
    `${details.action}: about ${amount(details.amount)} ${details.unit}.`,

  /** The wallet is open and waiting for the user. */
  awaitingSignature: (action: TxAction) =>
    `${action}: confirm the transaction in your wallet. Your wallet opens in a separate window.`,

  /** The user declined. Nothing was sent. */
  signatureRejected: (action: TxAction) =>
    `${action}: cancelled in your wallet. Nothing was sent.`,

  /** The transaction reached the network and is waiting for a ledger. */
  submitted: (action: TxAction) =>
    `${action}: sent to the network. Waiting for it to be confirmed.`,

  /** The transaction is on the ledger. */
  confirmed: (details: ConfirmedDetails) =>
    `${details.action}: confirmed. You received ${amount(details.amount)} ${details.unit}.`,

  /** A backend step is still running after the transaction was sent. */
  backendFollowUp: (action: TxAction) =>
    `${action}: waiting for OracleDesk to confirm it on-chain.`,

  /** The transaction failed. */
  failed: (error: DescribedError) => error.message,
};

/**
 * A user cancelling is not an error worth interrupting for, so it is
 * announced politely. Everything else is assertive.
 */
export function announcementPoliteness(kind: DescribedError["kind"]): "polite" | "assertive" {
  return kind === "rejected" ? "polite" : "assertive";
}

/**
 * The message for a failure, choosing the cancellation copy when the user
 * was the one who stopped it.
 */
export function failureMessage(action: TxAction, error: DescribedError): string {
  if (error.kind === "rejected") return txMessages.signatureRejected(action);
  return txMessages.failed(error);
}
