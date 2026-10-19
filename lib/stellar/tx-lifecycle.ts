import type { rpc, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import {
  describeError,
  describeSubmission,
  UserFacingError,
  type ContractName,
  type TxDescribedError,
} from "./errors";

export type { TxDescribedError };

export type TxPhase =
  | { name: "building" }
  | { name: "simulating" }
  | { name: "awaiting-signature" }
  | { name: "submitting"; hash: string }
  | { name: "pending"; hash: string; sentAt: number; attempts: number }
  | { name: "confirmed"; hash: string; ledger: number; returnValue?: xdr.ScVal }
  | { name: "failed"; hash: string | null; error: TxDescribedError }
  | { name: "expired"; hash: string; lastLedgerSeen: number };

/**
 * The value of a simulated call. Contract `Result`s are unwrapped; failures
 * become a UserFacingError named from the simulation's "Error(Contract, #N)".
 */
export function simulated<T>(tx: AssembledTransaction<unknown>, contract: ContractName = "marketCore"): T {
  const sim = tx.simulation as { error?: string } | undefined;
  let raw: unknown;
  try {
    raw = tx.result;
  } catch (err) {
    throw new UserFacingError(describeError(`${sim?.error ?? ""} ${String(err)}`, contract), err);
  }
  if (raw && typeof raw === "object" && "isOk" in raw && typeof (raw as { isOk: unknown }).isOk === "function") {
    const result = raw as { isOk(): boolean; unwrap(): T };
    if (!result.isOk()) throw new UserFacingError(describeError(`${sim?.error ?? ""}`, contract), raw);
    return result.unwrap();
  }
  return raw as T;
}

export class TxLifecycle<T> {
  private phase: TxPhase = { name: "building" };
  private listeners = new Set<() => void>();
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly getServer: () => rpc.Server;
  private readonly contract: ContractName;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly onHash?: (hash: string) => void;
  /** Called on every phase change of the run in flight. */
  private phaseListener: ((phase: TxPhase) => void) | null = null;

  constructor(opts: {
    /** A server, or a getter so each run uses the pool's (pinned) endpoint. */
    server: rpc.Server | (() => rpc.Server);
    contract: ContractName;
    pollIntervalMs?: number;
    maxPollMs?: number;
    onHash?: (hash: string) => void;
  }) {
    const server = opts.server;
    this.getServer = typeof server === "function" ? server : () => server;
    this.contract = opts.contract;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxPollMs = opts.maxPollMs ?? 60_000;
    this.onHash = opts.onHash;
  }

  getSnapshot = (): TxPhase => {
    return this.phase;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setPhase(newPhase: TxPhase) {
    this.phase = newPhase;
    try {
      this.phaseListener?.(newPhase);
    } catch {
      // A listener must never break the transaction.
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  abort(): void {
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async run(
    tx: AssembledTransaction<T>,
    parse: (v: xdr.ScVal | undefined) => T,
    onHash?: (hash: string) => void,
    onPhase?: (phase: TxPhase) => void,
  ): Promise<{ value: T; txHash: string; ledger: number }> {
    this.phaseListener = onPhase ?? null;
    try {
      return await this.runTransaction(tx, parse, onHash);
    } finally {
      this.phaseListener = null;
    }
  }

  private async runTransaction(
    tx: AssembledTransaction<T>,
    parse: (v: xdr.ScVal | undefined) => T,
    onHash?: (hash: string) => void,
  ): Promise<{ value: T; txHash: string; ledger: number }> {
    // 1. Simulating
    this.setPhase({ name: "simulating" });
    try {
      simulated(tx, this.contract);
    } catch (err) {
      const described: TxDescribedError =
        err instanceof UserFacingError ? err.described : describeError(err, this.contract);
      this.setPhase({ name: "failed", hash: null, error: described });
      if (err instanceof UserFacingError) throw err;
      throw new UserFacingError(described, err);
    }

    // 2. Awaiting signature
    this.setPhase({ name: "awaiting-signature" });
    try {
      await tx.sign();
    } catch (err) {
      const described: TxDescribedError = describeError(err, this.contract);
      this.setPhase({ name: "failed", hash: null, error: described });
      throw new UserFacingError(described, err);
    }

    const signed = (tx as unknown as { signed?: { hash: () => Buffer; timeBounds?: { maxTime?: string | number } } }).signed;
    if (!signed) {
      const error: TxDescribedError = {
        kind: "unknown",
        message: "Signing succeeded but no signed transaction was found.",
      };
      this.setPhase({ name: "failed", hash: null, error });
      throw new UserFacingError(error);
    }

    const hash = signed.hash().toString("hex").toLowerCase();
    this.onHash?.(hash);
    onHash?.(hash);

    // 3. Submitting
    this.setPhase({ name: "submitting", hash });
    let sendRes: rpc.Api.SendTransactionResponse;
    try {
      sendRes = await this.getServer().sendTransaction(signed as unknown as import("@stellar/stellar-sdk").Transaction);
    } catch (err) {
      const described: TxDescribedError = {
        ...describeError(err, this.contract),
        submission: "rejected-by-network",
      };
      this.setPhase({ name: "failed", hash, error: described });
      throw new UserFacingError(described, err);
    }

    if (sendRes.status === "TRY_AGAIN_LATER") {
      const error: TxDescribedError = {
        kind: "submission",
        submission: "try-again-later",
        message: "The network is busy. Please try again in a moment.",
      };
      this.setPhase({ name: "failed", hash, error });
      throw new UserFacingError(error, sendRes);
    }

    if (sendRes.status === "ERROR") {
      const error = describeSubmission(sendRes, this.contract);
      this.setPhase({ name: "failed", hash, error });
      throw new UserFacingError(error, sendRes);
    }

    // PENDING or DUPLICATE -> start polling
    const sentAt = Date.now();
    let attempts = 0;
    this.setPhase({ name: "pending", hash, sentAt, attempts });

    let delayMs = this.pollIntervalMs;
    let initialLedgerCloseTime: number | null = null;

    while (!this.aborted) {
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, delayMs);
      });
      if (this.aborted) {
        throw new UserFacingError({
          kind: "unknown",
          message: "Transaction monitoring was aborted.",
        });
      }

      attempts++;
      delayMs = Math.min(Math.floor(delayMs * 1.5), 5000);

      let getRes: rpc.Api.GetTransactionResponse;
      try {
        getRes = await this.getServer().getTransaction(hash);
      } catch {
        // Transient network error; continue polling
        continue;
      }

      if (getRes.status === "SUCCESS") {
        let value: T;
        try {
          value = parse(getRes.returnValue);
        } catch (error) {
          throw new UserFacingError({ kind: "unknown", message: "The transaction confirmed, but its returned amount could not be decoded. Refresh your balance." }, error);
        }
        this.setPhase({
          name: "confirmed",
          hash,
          ledger: getRes.ledger ?? getRes.latestLedger,
          returnValue: getRes.returnValue,
        });
        return { value, txHash: hash, ledger: getRes.ledger };
      }

      if (getRes.status === "FAILED") {
        const fullErrText = `${getRes.resultXdr ? String(getRes.resultXdr) : ""} ${getRes.resultMetaXdr ? String(getRes.resultMetaXdr) : ""}`;
        const described = describeError(fullErrText || "Transaction failed on chain", this.contract);
        const error: TxDescribedError = {
          ...described,
          submission: "failed-on-chain",
        };
        this.setPhase({ name: "failed", hash, error });
        throw new UserFacingError(error, getRes);
      }

      if (getRes.status === "NOT_FOUND") {
        this.setPhase({ name: "pending", hash, sentAt, attempts });

        if (initialLedgerCloseTime === null && getRes.latestLedgerCloseTime) {
          initialLedgerCloseTime = getRes.latestLedgerCloseTime;
        }

        const maxTimeRaw = signed.timeBounds?.maxTime;
        const maxTime = maxTimeRaw ? BigInt(maxTimeRaw) : 0n;
        const isPastTimeBound =
          maxTime > 0n &&
          getRes.latestLedgerCloseTime !== undefined &&
          BigInt(getRes.latestLedgerCloseTime) > maxTime;
        const isPastMaxPoll =
          initialLedgerCloseTime !== null &&
          getRes.latestLedgerCloseTime !== undefined &&
          (getRes.latestLedgerCloseTime - initialLedgerCloseTime) * 1000 >= this.maxPollMs;

        if (isPastTimeBound || isPastMaxPoll) {
          const error: TxDescribedError = {
            kind: "expired",
            submission: "not-found-after-timeout",
            message: "Transaction expired before reaching a ledger.",
          };
          this.setPhase({ name: "expired", hash, lastLedgerSeen: getRes.latestLedger });
          throw new UserFacingError(error, getRes);
        }
      }
    }

    throw new UserFacingError({
      kind: "unknown",
      message: "Transaction monitoring was aborted.",
    });
  }
}
