"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Keypair, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { useWalletAddress, useWalletNetwork, useWalletSigner } from "@/lib/contexts/WalletContext";
import { currentRpcUrl, marketCore, reasoningRegistry, rpcPool, token, Outcomes, rpcServer, withPinnedRpc, type OutcomeTag, type Signer } from "@/lib/stellar/clients";
import { createMarketBatcher } from "@/lib/stellar/market-batch";
import { DEBUG_ENABLED } from "@/lib/diagnostics/flags";
import { recordSimulation } from "@/lib/diagnostics/events";
import { useUpdatePending } from "@/lib/pwa/update-context";
import { describeError, describeSubmission, UserFacingError, type ContractName } from "@/lib/stellar/errors";
import { BPS, priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Config, Market as OnChainMarket, Position } from "@/lib/stellar/generated/market-core";
import { verifyTraceInWorker, type TraceCheck } from "@/lib/stellar/trace";
import { read, submit, bytesToHex, simulatedWithLedger, simulated } from "@/lib/stellar/typed-call";
import { maxIn, minOut } from "@/lib/stellar/units";
import {
  feeBreakdown,
  fetchBaseReserve,
  spendableXlm,
  type AccountReserve,
  type FeeBreakdown,
} from "@/lib/stellar/fees";
import {
  TxLifecycle,
  type TxPhase,
} from "@/lib/stellar/tx-lifecycle";
import { useTxTracker } from "@/lib/stellar/tx-tracker";
import { tradeInvalidationKeys } from "@/lib/stellar/tx-tracker-core";
import { CONTRACTS, NETWORK_PASSPHRASE } from "@/lib/stellar/config";

import { preflightBuy, preflightRedeem, type Preflight, type PreflightFailure, type PreflightInput } from "@/lib/stellar/preflight";
import { getSubmitQueue } from "@/lib/stellar/submit-queue";
import { assertIntentMatches, describeAssembled, type ReviewModel } from "@/lib/stellar/tx-decode";
import { discoverRedeemable, loadRedeemAllResume, saveRedeemAllResume, type ItemState, type RedeemAllResume, type RedeemDiscovery } from "@/lib/stellar/redeem-all";
import { enableUsdcTrustline, getTrustlineState, usdcClassicAsset, type TrustlineState } from "@/lib/stellar/trustline";
import { minCollateralForShares } from "@/lib/stellar/quote";
import { reconcileWithQuote, solveSellForShares } from "@/lib/stellar/sell-solver";
import { confirmTrade, cancelTradeReads } from "@/lib/stellar/optimistic-cache";
import { reconcileRead, type Stamped } from "@/lib/stellar/optimistic";
import {
  MULTISIG_DEFAULT_SLIPPAGE_BPS,
  MULTISIG_DEFAULT_TIMEOUT_S,
  MULTISIG_SESSIONS_KEY,
  isExpiredByLedger,
  isExpiredByWallClock,
  isMultisigAccount,
  loadMultisigSessions,
  mergeSigned,
  nonInvokerAddresses,
  readAccountAuth,
  removeMultisigSession,
  requiredThreshold,
  signatureWeight,
  upsertMultisigSession,
  type AccountAuth,
  type MultisigSession,
} from "@/lib/stellar/multisig";

export { tradeInvalidationKeys };

export { read, submit, simulated, bytesToHex };

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  traceCount: ["stellar", "traceCount"] as const,
  config: ["stellar", "config"] as const,
  ledgerNow: ["stellar", "ledgerNow"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit = 20) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  myPositions: (holder: string, totalMarkets: string) =>
    ["stellar", "myPositions", holder, totalMarkets] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  trustline: (owner: string) => ["stellar", "usdcTrustline", owner] as const,
  account: (addr: string) => ["stellar", "account", addr] as const,
  rpcNetwork: ["stellar", "rpcNetwork"] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  exactBuy: (id: string, outcome: OutcomeTag, target: string) => ["stellar", "exactBuy", id, outcome, target] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};

const toId = (id: bigint | string | number) => BigInt(id);

/**
 * Builds (and so simulates) a read against the pool's current endpoint, and
 * records latency, success and the simulated ledger into the RPC pool (and
 * the debug ring buffer when enabled). Recording never throws into the caller.
 */
async function measured<Tx extends AssembledTransaction<unknown>>(method: string, build: () => Promise<Tx>, contract: ContractName | "usdc" = "marketCore"): Promise<Tx> {
  const url = currentRpcUrl();
  const t0 = Date.now();
  try {
    const tx = await build();
    const sim = tx.simulation as { latestLedger?: number; error?: string } | undefined;
    try {
      rpcPool()?.record(url, { ms: Date.now() - t0, ok: true, latestLedger: sim?.latestLedger });
      if (DEBUG_ENABLED) recordSimulation(simRecord(contract, method, tx));
    } catch { /* telemetry only */ }
    return tx;
  } catch (err) {
    try {
      const status = /\b429\b|rate.?limit/i.test(String((err as Error)?.message ?? err)) ? 429 : undefined;
      rpcPool()?.record(url, { ms: Date.now() - t0, ok: false, status });
      if (DEBUG_ENABLED) recordSimulation({ at: Date.now(), contract, method, error: describeError(err).message });
    } catch { /* telemetry only */ }
    throw err;
  }
}

function simRecord(contract: ContractName | "usdc", method: string, tx: AssembledTransaction<unknown>) {
  const sim = tx.simulation as
    | { latestLedger?: number; minResourceFee?: string; error?: string; transactionData?: { build?: () => { resources(): { footprint(): { readOnly(): unknown[]; readWrite(): unknown[] } } } } }
    | undefined;
  let readEntries: number | undefined;
  let writeEntries: number | undefined;
  try {
    const fp = sim?.transactionData?.build?.().resources().footprint();
    readEntries = fp?.readOnly().length;
    writeEntries = fp?.readWrite().length;
  } catch { /* shape differs between success/restore/error simulations */ }
  return { at: Date.now(), contract, method, latestLedger: sim?.latestLedger, readEntries, writeEntries, minResourceFee: sim?.minResourceFee, error: sim?.error };
}

async function trustlineFor(address: string): Promise<TrustlineState> {
  return getTrustlineState(address, await usdcClassicAsset());
}

async function requireUsdcTrustline(address: string): Promise<TrustlineState> {
  const state = await trustlineFor(address);
  if (state.kind === "missing") {
    throw new UserFacingError({
      kind: "no-trustline",
      message: "Enable your USDC trustline before using USDC.",
      action: "enable-usdc",
    });
  }
  if (state.kind === "account-missing") {
    throw new UserFacingError({ kind: "unknown", message: "Your Stellar account is not funded yet. Fund it before continuing." });
  }
  if (state.kind === "present" && !state.authorized) {
    throw new UserFacingError({ kind: "no-trustline", message: "The issuer hasn't authorized your USDC trustline." });
  }
  return state;
}

/** Close time of the latest ledger, in seconds: the clock the contracts use for time-based rules. */
export async function fetchLedgerNow(): Promise<bigint> {
  const latest = await rpcServer().getLatestLedger();
  const response = await rpcServer().getTransactions({
    startLedger: latest.sequence,
    pagination: { limit: 1 },
  });
  return BigInt(response.latestLedgerCloseTimestamp);
}

async function fetchMarketConfig(): Promise<Config> {
  return simulated(await marketCore().get_config());
}

async function fetchUsdcBalanceIfAvailable(owner: string): Promise<bigint | undefined> {
  try {
    return simulated(await token.balance(owner));
  } catch (error) {
    if (describeError(error).kind === "no-trustline") return undefined;
    throw error;
  }
}

function throwPreflight(preflight: Preflight): void {
  if (preflight.ok !== false) return;
  const first = preflight.failures[0] as PreflightFailure;
  throw new UserFacingError({
    kind: first.code === "InsufficientBalance" ? "insufficient-balance" : "contract",
    code: first.code,
    message: first.message,
  });
}

function queueId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assertSignerCurrent(guard: () => Signer, expectedAddress: string): Signer {
  const current = guard();
  if (current.publicKey !== expectedAddress) {
    throw new UserFacingError({ kind: "disconnected", message: "Your wallet changed before this transaction could be signed." });
  }
  return current;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export function useMarketCount() {
  return useQuery({
    queryKey: stellarKeys.marketCount,
    queryFn: async () => read(await marketCore().market_count()),
    staleTime: 30_000,
  });
}

/** Number of traces the reasoning registry has accepted. */
export function useTraceCount() {
  return useQuery({
    queryKey: stellarKeys.traceCount,
    queryFn: async () => read(await measured("trace_count", () => reasoningRegistry().trace_count(), "reasoningRegistry")),
    staleTime: 30_000,
  });
}

export function useMarketConfig() {
  return useQuery({
    queryKey: stellarKeys.config,
    queryFn: fetchMarketConfig,
    staleTime: 60_000,
  });
}

export function useLedgerNow() {
  return useQuery({
    queryKey: stellarKeys.ledgerNow,
    queryFn: fetchLedgerNow,
    staleTime: 5_000,
  });
}

export interface OnChainMarketView {
  id: string;
  market: OnChainMarket;
  /** YES price in bps, from the contract's own FPMM math. */
  yesBps: number;
  /** Ledger the read was simulated at, or null if the RPC didn't say. */
  ledger: number | null;
}

/** The simulation read. Write flows use this directly so the read is at least
 * as fresh as the transaction they are about to build. */
export async function fetchOnChainMarketBySimulation(id: bigint | string): Promise<OnChainMarketView> {
  const tx = await measured("get_market", () => marketCore().get_market({ market_id: toId(id) }));
  const market = read(tx);
  const ledger = tx.simulation?.latestLedger;
  return { id: String(id), market, yesBps: Number(priceYesBps(market.reserve_yes, market.reserve_no)), ledger: typeof ledger === "number" ? ledger : null };
}

const marketBatcher = createMarketBatcher({
  server: rpcServer(),
  spec: marketCore().spec,
  fallback: fetchOnChainMarketBySimulation,
});

/** Reads one market through the shared ledger-entry batcher, falling back to
 * the binding's simulation for missing or archived entries. */
export async function fetchOnChainMarket(id: bigint | string): Promise<OnChainMarketView> {
  return (await marketBatcher.load(toId(id))).view;
}

/** Keeps the cached view when a refetch came from an endpoint on an older ledger. */
export function newerMarketView(cached: OnChainMarketView | undefined, fresh: OnChainMarketView): OnChainMarketView {
  if (cached?.ledger != null && fresh.ledger != null && fresh.ledger < cached.ledger) return cached;
  return fresh;
}

export function useOnChainMarket(id: bigint | string | null | undefined) {
  const client = useQueryClient();
  return useQuery({
    queryKey: stellarKeys.market(String(id)),
    queryFn: async () =>
      newerMarketView(client.getQueryData<OnChainMarketView>(stellarKeys.market(String(id))), await fetchOnChainMarket(id as string)),
    enabled: id !== null && id !== undefined && id !== "",
    staleTime: 15_000,
    // One page-level heartbeat refetches every visible market together, so
    // the batcher gets one request per refresh cycle instead of one per card.
  });
}

/**
 * Refreshes every active market read (cards and the newest-on-chain section)
 * together. All query functions run in the same tick, so market-batch coalesces
 * them into one getLedgerEntries request per 200 markets.
 */
export function useMarketsHeartbeat() {
  const client = useQueryClient();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void client.refetchQueries({ queryKey: ["stellar", "market"], type: "active" });
      void client.refetchQueries({ queryKey: ["stellar", "markets"], type: "active" });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [client]);
}

/**
 * Newest first: ids count-1 … count-limit, read in batches.
 */
export function useOnChainMarkets(limit = 20) {
  const count = useMarketCount();
  const total = count.data;
  return useQuery({
    queryKey: [...stellarKeys.markets(limit), total?.toString() ?? "?"],
    enabled: total !== undefined,
    queryFn: async () => {
      const ids: bigint[] = [];
      for (let i = (total as bigint) - 1n; i >= 0n && ids.length < limit; i--) ids.push(i);
      const results = await marketBatcher.loadMany(ids);
      return ids.flatMap((id) => {
        const result = results.get(id.toString());
        return result && !(result instanceof Error) ? [result.view] : [];
      });
    },
    staleTime: 30_000,
  });
}

function positionOptions(client: ReturnType<typeof useQueryClient>, id: bigint | string | null | undefined, holder: string | null | undefined) {
  const queryKey = stellarKeys.position(String(id), holder ?? "");
  return {
    queryKey,
    enabled: id !== null && id !== undefined && id !== "" && Boolean(holder),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Stamped<Position>> => {
      const fresh = simulatedWithLedger(await measured("get_position", () => marketCore().get_position({ market_id: toId(id as string), holder: holder as string })));
      signal.throwIfAborted();
      return reconcileRead(client.getQueryData(queryKey), fresh, (a, b) => a.yes === b.yes && a.no === b.no, queryKey);
    },
    staleTime: 15_000,
  };
}
export function usePosition(id: bigint | string | null | undefined, holder: string | null | undefined) {
  const client = useQueryClient();
  return useQuery({ ...positionOptions(client, id, holder), select: (data: Stamped<Position>) => data.value });
}
export function usePositionState(id: bigint | string | null | undefined, holder: string | null | undefined) {
  return useQuery(positionOptions(useQueryClient(), id, holder));
}
function balanceOptions(client: ReturnType<typeof useQueryClient>, owner: string | null | undefined) {
  const queryKey = stellarKeys.balance(owner ?? "");
  return {
    queryKey,
    enabled: Boolean(owner),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Stamped<bigint>> => {
      const fresh = simulatedWithLedger(await measured("balance", () => token.balance(owner as string), "usdc"));
      signal.throwIfAborted();
      return reconcileRead(client.getQueryData(queryKey), fresh, (a, b) => a === b, queryKey);
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  };
}
export function useUsdcBalance(owner: string | null | undefined) {
  return useQuery({ ...balanceOptions(useQueryClient(), owner), select: (data: Stamped<bigint>) => data.value });
}
export function useUsdcBalanceState(owner: string | null | undefined) {
  return useQuery(balanceOptions(useQueryClient(), owner));
}

export interface AccountReserveState extends AccountReserve {
  funded: boolean;
}

/**
 * Reads account entry via getLedgerEntries on the account key. Polls faster
 * while the account is unfunded, so the UI flips soon after a Friendbot top-up.
 */
export function useAccountReserve(address: string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.account(address ?? ""),
    enabled: Boolean(address),
    queryFn: async (): Promise<AccountReserveState> => {
      if (!address) {
        return {
          funded: false,
          balance: 0n,
          minBalance: 0n,
          sellingLiabilities: 0n,
          spendable: 0n,
          subentries: 0,
          sponsoring: 0,
          sponsored: 0,
        };
      }
      try {
        const kp = Keypair.fromPublicKey(address);
        const key = xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({
            accountId: kp.xdrPublicKey(),
          }),
        );
        const res = await rpcServer().getLedgerEntries(key);
        if (!res.entries || res.entries.length === 0) {
          return {
            funded: false,
            balance: 0n,
            minBalance: 0n,
            sellingLiabilities: 0n,
            spendable: 0n,
            subentries: 0,
            sponsoring: 0,
            sponsored: 0,
          };
        }

        let accountEntry: xdr.AccountEntry | null = null;
        const raw = res.entries[0] as unknown as { val?: xdr.LedgerEntryData; xdr?: string };
        if (raw.val && typeof raw.val.account === "function") {
          accountEntry = raw.val.account();
        } else if (typeof raw.xdr === "string") {
          const ledgerEntryData = xdr.LedgerEntryData.fromXDR(raw.xdr, "base64");
          accountEntry = ledgerEntryData.account();
        }

        if (!accountEntry) {
          return {
            funded: false,
            balance: 0n,
            minBalance: 0n,
            sellingLiabilities: 0n,
            spendable: 0n,
            subentries: 0,
            sponsoring: 0,
            sponsored: 0,
          };
        }

        const baseReserve = await fetchBaseReserve();
        const reserve = spendableXlm(accountEntry, baseReserve);
        return {
          funded: true,
          ...reserve,
        };
      } catch (err) {
        // Fall back gracefully if account fetch fails
        throw err;
      }
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useUsdcTrustline(owner: string | null | undefined) {
  const { isWrongNetwork } = useWalletNetwork();
  return useQuery({
    queryKey: stellarKeys.trustline(owner ?? ""),
    enabled: Boolean(owner) && !isWrongNetwork,
    queryFn: () => trustlineFor(owner as string),
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}

export function useEnableUsdc() {
  const signer = useWriteGuard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const wallet = signer();
      const asset = await usdcClassicAsset();
      const current = await getTrustlineState(wallet.publicKey, asset);
      if (current.kind === "native" || (current.kind === "present" && current.authorized)) {
        return { hash: null, holder: wallet.publicKey };
      }
      if (current.kind === "present" && !current.authorized) {
        throw new UserFacingError({
          kind: "no-trustline",
          message: "The issuer hasn't authorized your USDC trustline.",
        });
      }
      const { hash } = await enableUsdcTrustline(wallet.publicKey, asset, wallet);
      const deadline = Date.now() + 60_000;
      let delay = 1_000;
      while (Date.now() < deadline) {
        const state = await getTrustlineState(wallet.publicKey, asset);
        if (state.kind === "present" && state.authorized) return { hash, holder: wallet.publicKey };
        if (state.kind === "present") {
          throw new UserFacingError({
            kind: "no-trustline",
            message: "The issuer hasn't authorized your USDC trustline.",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5_000);
      }
      throw new UserFacingError({
        kind: "network",
        message: "The trustline transaction confirmed, but the new trustline is not visible yet. Refresh and check again.",
      });
    },
    onSuccess: ({ holder }) => {
      void queryClient.invalidateQueries({ queryKey: stellarKeys.trustline(holder) });
      void queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) });
    },
  });
}

/** Shares a buy would return right now. Debounce `collateralIn` at the call site. */
export function useQuoteBuy(id: bigint | string | null | undefined, outcome: OutcomeTag, collateralIn: bigint | null) {
  return useQuery({
    queryKey: stellarKeys.quoteBuy(String(id), outcome, collateralIn?.toString() ?? ""),
    enabled: id !== null && id !== undefined && collateralIn !== null && collateralIn > 0n,
    queryFn: async () =>
      read(
        await measured("quote_buy", () =>
          marketCore().quote_buy({ market_id: toId(id as string), outcome: Outcomes[outcome], collateral_in: collateralIn as bigint }),
        ),
      ),
    staleTime: 5_000,
  });
}

export function useExactBuyQuote(
  id: bigint | string | null | undefined,
  outcome: OutcomeTag,
  targetShares: bigint | null,
) {
  return useQuery({
    queryKey: stellarKeys.exactBuy(String(id), outcome, targetShares?.toString() ?? ""),
    enabled: id !== null && id !== undefined && targetShares !== null && targetShares > 0n,
    queryFn: async () => {
      const view = await fetchOnChainMarket(id as string);
      const local = minCollateralForShares(view.market, outcome, targetShares as bigint);
      if (!local.ok) {
        const message =
          local.reason === "market-too-large"
            ? "This target exceeds the market's remaining size limit."
            : local.reason === "invalid-target"
              ? "Enter a share amount greater than zero."
              : "The requested share amount is too large.";
        throw new UserFacingError({ kind: "contract", message });
      }
      const quotedShares = simulated(
        await marketCore().quote_buy({
          market_id: toId(id as string),
          outcome: Outcomes[outcome],
          collateral_in: local.collateralIn,
        }),
      );
      if (quotedShares < (targetShares as bigint)) {
        throw new UserFacingError({ kind: "contract", message: "The price moved; refresh the quote and try again." });
      }
      return { ...local, quotedShares, market: view.market };
    },
    staleTime: 5_000,
  });
}

export interface PreparedBuy {
  tx: AssembledTransaction<unknown>;
  fees: FeeBreakdown;
  quote: bigint;
  minSharesOut: bigint;
  preparedAt: number;
}

/** Pre-builds and simulates a buy transaction to preview fees and min shares. */
export function usePrepareBuy(params: {
  marketId: bigint | string | null | undefined;
  outcome: OutcomeTag;
  collateralIn: bigint | null;
  slippageBps: number;
  holder: string | null | undefined;
}) {
  const { marketId, outcome, collateralIn, slippageBps, holder } = params;
  return useQuery({
    queryKey: [
      "stellar",
      "prepareBuy",
      marketId?.toString() ?? "",
      outcome,
      collateralIn?.toString() ?? "",
      slippageBps,
      holder ?? "",
    ] as const,
    enabled: Boolean(marketId) && Boolean(holder) && collateralIn !== null && collateralIn > 0n,
    queryFn: async (): Promise<PreparedBuy> => {
      const id = toId(marketId!);
      const quote = simulated(
        await marketCore().quote_buy({
          market_id: id,
          outcome: Outcomes[outcome],
          collateral_in: collateralIn!,
        }),
      );
      const minSharesOut = minOut(quote, slippageBps);
      const dummySigner: Signer = {
        publicKey: holder!,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
      };
      const tx = await marketCore(dummySigner).buy({
        trader: holder!,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_in: collateralIn!,
        min_shares_out: minSharesOut,
      });
      const fees = feeBreakdown(tx);
      return {
        tx,
        fees,
        quote,
        minSharesOut,
        preparedAt: Date.now(),
      };
    },
    staleTime: 5_000,
  });
}

export interface PreparedUsdcTransfer {
  tx: AssembledTransaction<null>;
  fees: FeeBreakdown;
  amount: bigint;
  preparedAt: number;
}

/** Pre-builds and simulates a SAC transfer to preview network fees. */
export function usePrepareUsdcTransfer(params: {
  to: string | null | undefined;
  amount: bigint | null;
  holder: string | null | undefined;
}) {
  const { to, amount, holder } = params;
  return useQuery({
    queryKey: [
      "stellar",
      "prepareUsdcTransfer",
      to ?? "",
      amount?.toString() ?? "",
      holder ?? "",
    ] as const,
    enabled: Boolean(to) && Boolean(holder) && amount !== null && amount > 0n,
    queryFn: async (): Promise<PreparedUsdcTransfer> => {
      const dummySigner: Signer = {
        publicKey: holder!,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
      };
      const tx = await token.transfer({ from: holder!, to: to!, amount: amount! }, dummySigner);
      const fees = feeBreakdown(tx);
      return {
        tx,
        fees,
        amount: amount!,
        preparedAt: Date.now(),
      };
    },
    staleTime: 5_000,
  });
}

export interface VerifiedTrace {
  onChainTraceId: string;
  marketId: string;
  agent: string;
  action: string;
  ipfsCid: string;
  onChainHash: string;
  publishedAt: number;
  check: TraceCheck;
}

/** Reads the trace from reasoning-registry, then fetches and hash-checks its content. */
export function useVerifiedTrace(onChainTraceId: bigint | string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.trace(String(onChainTraceId)),
    enabled: onChainTraceId !== null && onChainTraceId !== undefined && onChainTraceId !== "",
    queryFn: async ({ signal }): Promise<VerifiedTrace> => {
      const trace = read(await reasoningRegistry().get_trace({ trace_id: toId(onChainTraceId as string) }), "reasoningRegistry");
      const onChainHash = bytesToHex(trace.trace_hash);
      return {
        onChainTraceId: String(onChainTraceId),
        marketId: trace.market_id.toString(),
        agent: trace.agent,
        action: trace.action,
        ipfsCid: trace.ipfs_cid,
        onChainHash,
        publishedAt: Number(trace.published_at),
        check: await verifyTraceInWorker(trace.ipfs_cid, onChainHash, { signal }),
      };
    },
    staleTime: 5 * 60_000,
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

function useWriteGuard(): () => Signer {
  const signer = useWalletSigner();
  const { isWrongNetwork } = useWalletNetwork();
  const queryClient = useQueryClient();
  const updatePending = useUpdatePending();
  // The guard's identity is stable, so the write hooks don't get a new
  // mutation function on every wallet change.
  return useCallback(() => {
    // Never sign with an outdated bundle (stale contract ids or slippage logic).
    if (updatePending) {
      throw new UserFacingError({ kind: "unknown", message: "Reload to update OracleDesk before signing." });
    }
    if (!signer) {
      throw new UserFacingError({ kind: "disconnected", message: "Connect your wallet first." });
    }
    if (isWrongNetwork) {
      throw new UserFacingError({ kind: "wrong-network", message: "Switch your wallet to Stellar Testnet and try again." });
    }
    // An unfunded account has no ledger entry, so building any transaction
    // from it would fail with a raw SDK error. Refuse here, in plain words.
    const account = queryClient.getQueryData<AccountReserveState>(stellarKeys.account(signer.publicKey));
    if (account && !account.funded) {
      throw new UserFacingError({
        kind: "account-not-found",
        message: "Your Stellar account isn't activated yet. Fund it with XLM first.",
      });
    }
    return signer;
  }, [signer, isWrongNetwork, queryClient, updatePending]);
}

export function useInvalidateAfterTrade() {
  const queryClient = useQueryClient();
  return (marketId: string, holder: string) => {
    for (const key of tradeInvalidationKeys(marketId, holder)) {
      queryClient.invalidateQueries({ queryKey: key });
    }
    // Fees change the XLM balance, so the account entry is stale after a trade.
    queryClient.invalidateQueries({ queryKey: stellarKeys.account(holder) });
  };
}

/** The RPC's network info, including the Friendbot URL on testnet. */
export function useRpcNetwork() {
  return useQuery({
    queryKey: stellarKeys.rpcNetwork,
    queryFn: () => rpcServer().getNetwork(),
    staleTime: Infinity,
  });
}

function confirmedAmount(value: xdr.ScVal | undefined): bigint {
  if (!value) throw new Error("Transaction confirmed without a return value. Refresh your balance.");
  const decoded: unknown = scValToNative(value);
  if (typeof decoded !== "bigint" || decoded < 0n) throw new Error("Invalid confirmed contract amount");
  return decoded;
}

function useTxRunner(contract: ContractName) {
  const [runner] = useState(() => new TxLifecycle<unknown>({ server: () => rpcServer(), contract }));
  const phase = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const start = useCallback(<T, R = T>(tx: AssembledTransaction<T>, parse: (v: xdr.ScVal | undefined) => R, onHash?: (hash: string) => void, onPhase?: (phase: TxPhase) => void) => {
    const run = runner.run(tx as AssembledTransaction<unknown>, parse, onHash, onPhase) as Promise<{ value: R; txHash: string; ledger: number }>;
    if (!DEBUG_ENABLED) return run;
    const method = `submit:${String((tx as { options?: { method?: string } }).options?.method ?? "tx")}`;
    return run.then(
      (r) => {
        recordSimulation({ ...simRecord(contract, method, tx as AssembledTransaction<unknown>), txHash: r.txHash });
        return r;
      },
      (err) => {
        recordSimulation({ ...simRecord(contract, method, tx as AssembledTransaction<unknown>), error: describeError(err, contract).message });
        throw err;
      },
    );
  }, [runner, contract]);
  return { phase, start };
}

export interface BuyParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  collateralIn: bigint;
  slippageBps: number;
  confirmBoundsChanged?: (previous: bigint, next: bigint) => Promise<boolean>;
  review?: PreparedWriteReview;
  /**
   * Called on every phase of the transaction, so a screen reader can be told
   * that the wallet is waiting, that the transaction was sent and that it
   * failed. Additive: existing callers compile unchanged.
   */
  onPhase?: (phase: TxPhase) => void;
}

export interface PreparedWrite {
  tx: AssembledTransaction<unknown>;
  kind: "buy" | "sell" | "redeem" | "usdc-transfer";
  contract: ContractName | "usdc";
  derived: Record<string, { value: bigint; from: string }>;
  intent: Record<string, string>;
  builtAt: number;
  quote?: bigint;
}

export type PreparedWriteReview = (
  prepared: PreparedWrite,
  model: ReviewModel,
  changedFrom?: ReviewModel,
  forceReview?: boolean,
) => Promise<boolean>;

export async function prepareBuy(
  signer: Signer,
  params: Omit<BuyParams, "confirmBoundsChanged">,
  opts?: { timeoutInSeconds?: number; sourceAccount?: string },
): Promise<PreparedWrite> {
  const id = toId(params.marketId);
  const source = opts?.sourceAccount ?? signer.publicKey;
  const quote = simulated(
    await marketCore().quote_buy({ market_id: id, outcome: Outcomes[params.outcome], collateral_in: params.collateralIn }),
  );
  const minSharesOut = minOut(quote, params.slippageBps);
  const buildSigner: Signer =
    opts?.sourceAccount && opts.sourceAccount !== signer.publicKey
      ? { publicKey: source, signTransaction: signer.signTransaction }
      : signer;
  const timeout = opts?.timeoutInSeconds;
  const tx = await marketCore(buildSigner, timeout !== undefined ? { timeoutInSeconds: timeout } : undefined).buy(
    {
      trader: source,
      market_id: id,
      outcome: Outcomes[params.outcome],
      collateral_in: params.collateralIn,
      min_shares_out: minSharesOut,
    },
    timeout !== undefined ? { timeoutInSeconds: timeout } : undefined,
  );
  simulated(tx);
  return {
    tx,
    kind: "buy",
    contract: "marketCore",
    derived: { min_shares_out: { value: minSharesOut, from: `quote ${quote.toString()} shares, ${params.slippageBps / 100}% slippage` } },
    intent: {
      trader: source,
      market_id: id.toString(),
      outcome: params.outcome,
      collateral_in: params.collateralIn.toString(),
      min_shares_out: minSharesOut.toString(),
    },
    builtAt: Date.now(),
    quote,
  };
}

export async function prepareSell(
  signer: Signer,
  params: { marketId: bigint | string; outcome: OutcomeTag; collateralOut: bigint; maxSharesIn: bigint },
  opts?: { timeoutInSeconds?: number; sourceAccount?: string },
): Promise<PreparedWrite> {
  const id = toId(params.marketId);
  const source = opts?.sourceAccount ?? signer.publicKey;
  const buildSigner: Signer =
    opts?.sourceAccount && opts.sourceAccount !== signer.publicKey
      ? { publicKey: source, signTransaction: signer.signTransaction }
      : signer;
  const timeout = opts?.timeoutInSeconds;
  const tx = await marketCore(buildSigner, timeout !== undefined ? { timeoutInSeconds: timeout } : undefined).sell(
    {
      trader: source,
      market_id: id,
      outcome: Outcomes[params.outcome],
      collateral_out: params.collateralOut,
      max_shares_in: params.maxSharesIn,
    },
    timeout !== undefined ? { timeoutInSeconds: timeout } : undefined,
  );
  simulated(tx);
  return {
    tx,
    kind: "sell",
    contract: "marketCore",
    derived: { max_shares_in: { value: params.maxSharesIn, from: "quote and slippage limit" } },
    intent: {
      trader: source,
      market_id: id.toString(),
      outcome: params.outcome,
      collateral_out: params.collateralOut.toString(),
      max_shares_in: params.maxSharesIn.toString(),
    },
    builtAt: Date.now(),
  };
}

export async function prepareRedeem(
  signer: Signer,
  marketId: bigint | string,
  opts?: { timeoutInSeconds?: number; sourceAccount?: string },
): Promise<PreparedWrite> {
  const id = toId(marketId);
  const source = opts?.sourceAccount ?? signer.publicKey;
  const buildSigner: Signer =
    opts?.sourceAccount && opts.sourceAccount !== signer.publicKey
      ? { publicKey: source, signTransaction: signer.signTransaction }
      : signer;
  const timeout = opts?.timeoutInSeconds;
  const tx = await marketCore(buildSigner, timeout !== undefined ? { timeoutInSeconds: timeout } : undefined).redeem(
    { holder: source, market_id: id },
    timeout !== undefined ? { timeoutInSeconds: timeout } : undefined,
  );
  simulated(tx);
  return {
    tx,
    kind: "redeem",
    contract: "marketCore",
    derived: {},
    intent: { holder: source, market_id: id.toString() },
    builtAt: Date.now(),
  };
}

export async function redeemOnce(
  signer: Signer,
  marketId: bigint | string,
  onSubmitting?: () => void,
  review?: PreparedWriteReview,
  attempt: 0 | 1 = 0,
): Promise<{ payout: bigint; txHash: string | null; ledger: number | null; holder: string }> {
  const id = toId(marketId);
  const view = await fetchOnChainMarketBySimulation(id);
  const position = simulated(await marketCore().get_position({ market_id: id, holder: signer.publicKey }));
  throwPreflight(preflightRedeem({ market: view.market, position }));
  const initial = await prepareRedeem(signer, id);
  const reviewed = await reviewPreparedWrite(initial, review, () => prepareRedeem(signer, id), undefined, attempt === 1);
  const prepared = reviewed.prepared;
  onSubmitting?.();
  const { value, txHash, ledger } = await submitPrepared<bigint>(prepared);
  return { payout: value, txHash, ledger, holder: signer.publicKey };
}

export async function prepareUsdcTransfer(
  signer: Signer,
  params: { to: string; amount: bigint },
  opts?: { timeoutInSeconds?: number; sourceAccount?: string },
): Promise<PreparedWrite> {
  const source = opts?.sourceAccount ?? signer.publicKey;
  const buildSigner: Signer =
    opts?.sourceAccount && opts.sourceAccount !== signer.publicKey
      ? { publicKey: source, signTransaction: signer.signTransaction }
      : signer;
  const tx = await token.transfer(
    { from: source, to: params.to, amount: params.amount },
    buildSigner,
    undefined,
    opts?.timeoutInSeconds !== undefined ? { timeoutInSeconds: opts.timeoutInSeconds } : {},
  );
  simulated(tx, "marketCore");
  return {
    tx,
    kind: "usdc-transfer",
    contract: "usdc",
    derived: {},
    intent: { from: source, to: params.to, amount: params.amount.toString() },
    builtAt: Date.now(),
  };
}

export async function submitPrepared<T>(
  prepared: PreparedWrite,
): Promise<{ value: T; txHash: string | null; ledger: number | null }> {
  return submit(prepared.tx, prepared.contract === "usdc" ? "marketCore" : prepared.contract) as Promise<{ value: T; txHash: string | null; ledger: number | null }>;
}

async function reviewPreparedWrite(
  initial: PreparedWrite,
  review: PreparedWriteReview | undefined,
  rebuild: () => Promise<PreparedWrite>,
  changedFrom?: ReviewModel,
  forceInitialReview = false,
): Promise<{ prepared: PreparedWrite; model?: ReviewModel }> {
  if (!review) return { prepared: initial };

  let current = initial;
  let previousModel = changedFrom;
  let forceReview = forceInitialReview || changedFrom !== undefined;
  while (true) {
    const model = describeAssembled(current.tx, current.contract === "usdc" ? "sac" : marketCore().spec, current.derived);
    assertPreparedInvocation(current, model);
    assertIntentMatches(model, current.intent);
    if (!(await review(current, model, previousModel, forceReview))) {
      throw new UserFacingError({ kind: "rejected", message: "You cancelled the transaction review." });
    }
    if (Date.now() - current.builtAt <= 20_000) return { prepared: current, model };

    const beforeRefresh = model;
    const refreshed = await rebuild();
    const freshModel = describeAssembled(
      refreshed.tx,
      refreshed.contract === "usdc" ? "sac" : marketCore().spec,
      refreshed.derived,
    );
    assertPreparedInvocation(refreshed, freshModel);
    assertIntentMatches(freshModel, refreshed.intent);
    current = refreshed;
    previousModel = beforeRefresh;
    forceReview = true;
  }
}

function assertPreparedInvocation(prepared: PreparedWrite, model: ReviewModel): void {
  const expectedContract = prepared.contract === "usdc" ? CONTRACTS.usdc : CONTRACTS[prepared.contract];
  const expectedFunction = {
    buy: "buy",
    sell: "sell",
    redeem: "redeem",
    "usdc-transfer": "transfer",
  }[prepared.kind];
  if (model.contractId !== expectedContract || model.fn !== expectedFunction) {
    throw new Error("The assembled transaction does not match the requested contract action.");
  }
}

function dedupeValue(...values: (string | number | bigint)[]): string {
  return values.map(String).join(":");
}

function runQueuedWrite<T>(
  signer: Signer,
  label: string,
  dedupeKey: string,
  guard: () => Signer,
  run: (attempt: 0 | 1) => Promise<T>,
): Promise<T> {
  return getSubmitQueue().enqueue({
    id: queueId(),
    address: signer.publicKey,
    label,
    dedupeKey,
    run: async ({ attempt, signal }) => {
      if (signal.aborted) throw new DOMException("The queued transaction was cancelled.", "AbortError");
      assertSignerCurrent(guard, signer.publicKey);
      // One endpoint for re-quote, simulate, submit and polling.
      return withPinnedRpc(() => run(attempt));
    },
  });
}

async function fetchTradePreflightInput(marketId: bigint, holder: string, includeBalance: boolean): Promise<PreflightInput> {
  const [view, config, ledgerNow, position, usdcBalance] = await Promise.all([
    fetchOnChainMarketBySimulation(marketId),
    fetchMarketConfig(),
    fetchLedgerNow(),
    marketCore()
      .get_position({ market_id: marketId, holder })
      .then((tx) => simulated(tx))
      .catch((error: unknown) => {
        throw new UserFacingError(describeError(error), error);
      }),
    includeBalance ? fetchUsdcBalanceIfAvailable(holder) : Promise.resolve(undefined),
  ]);
  return { market: view.market, config, ledgerNow, position, usdcBalance };
}

/**
 * Re-quotes right before building the transaction and sets
 * min_shares_out = minOut(quote, slippageBps), so slippage is enforced
 * on-chain (SlippageExceeded otherwise).
 *
 * Unmount safety: The underlying TxLifecycle runner keeps polling if the component
 * unmounts so React Query's mutation promise resolves and onSuccess cache invalidations
 * complete reliably.
 */
export function useBuy() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    onMutate: async (v: BuyParams & { prepared?: PreparedBuy }) => cancelTradeReads(queryClient, String(v.marketId), guard().publicKey),
    onError: (error, v, context) => {
      const kind = describeError(error).kind;
      if (context && ["network", "unknown", "expired", "submission"].includes(kind)) invalidate(String(v.marketId), context.holder);
    },
    mutationFn: async (params: BuyParams & { prepared?: PreparedBuy }) => {
      const signer = guard();
      const { marketId, outcome, collateralIn } = params;
      return runQueuedWrite(signer, `Buy ${outcome} on #${marketId}`, dedupeValue("buy", marketId, outcome, collateralIn), guard, async () => {
        await requireUsdcTrustline(signer.publicKey);
        const preflight = await fetchTradePreflightInput(toId(marketId), signer.publicKey, true);
        throwPreflight(preflightBuy(preflight, outcome, collateralIn));
        // Prepared transactions are fee previews signed by a dummy signer. Always
        // rebuild with the actual wallet and fresh bounds before asking for approval.
        const initial = await prepareBuy(signer, params);
        const { prepared } = await reviewPreparedWrite(initial, params.review, () => prepareBuy(signer, params));
        const quote = prepared.quote!;
        const minSharesOut = BigInt(prepared.intent.min_shares_out);
        const onHash = (hash: string) => tracker.track({ hash, kind: "buy", holder: signer.publicKey, marketId: String(marketId), outcome,
          amounts: { collateralIn: collateralIn.toString(), minSharesOut: minSharesOut.toString() }, networkPassphrase: NETWORK_PASSPHRASE });
        const { value, txHash, ledger } = await runner.start(prepared.tx, confirmedAmount, onHash, params.onPhase);
        return { sharesOut: value, quotedShares: quote, minSharesOut, txHash, ledger, collateralIn, holder: signer.publicKey };
      });
    },
    onSuccess: async (d, v) => {
      // Cancel again: a focus/refetch may have started while the wallet was signing.
      await cancelTradeReads(queryClient, String(v.marketId), d.holder);
      confirmTrade(queryClient, { ...v, ...d, kind: "buy", marketId: String(v.marketId) });
      for (const key of [stellarKeys.market(String(v.marketId)), ["stellar", "markets"], stellarKeys.account(d.holder)]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export type SellParams = {
  marketId: bigint | string;
  outcome: OutcomeTag;
  shares: bigint;
  mode?: "all" | "shares";
  slippageBps: number;
  review?: PreparedWriteReview;
}

export function useSell() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    onMutate: async (v: SellParams) => cancelTradeReads(queryClient, String(v.marketId), guard().publicKey),
    onError: (error, v, context) => {
      const kind = describeError(error).kind;
      if (context && ["network", "unknown", "expired", "submission"].includes(kind)) invalidate(String(v.marketId), context.holder);
    },
    mutationFn: async (params: SellParams) => {
      const { marketId, outcome, slippageBps } = params;
      const signer = guard();
      return runQueuedWrite(signer, `Sell ${outcome} on #${marketId}`, dedupeValue("sell", marketId, outcome, params.shares), guard, async () => {
      await requireUsdcTrustline(signer.publicKey);
      const id = toId(marketId);
      let { market } = await fetchOnChainMarketBySimulation(id);
      const position = simulated(
        await marketCore().get_position({ market_id: id, holder: signer.publicKey }),
      );
      const heldShares = outcome === "Yes" ? position.yes : position.no;
      const shares = params.mode === "all" ? heldShares : params.shares;
      if (shares <= 0n) {
        throw new UserFacingError({ kind: "contract", code: "InvalidAmount", message: "Enter a share amount greater than zero." });
      }
      if (shares > heldShares) {
        throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
      }
      const [rSold, rOther] = outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
      const feeBps = BigInt(market.fee_bps);
      let local = solveSellForShares(rSold, rOther, shares, feeBps);
      if ("error" in local) {
        throw new UserFacingError({
          kind: "contract",
          code: local.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
          message: local.error === "too-small"
            ? "That's too few shares to sell after fees."
            : "There isn't enough liquidity to sell that many shares.",
        });
      }

      const quoteAt = async (collateralOut: bigint) =>
        simulated(
          await marketCore().quote_sell({ market_id: id, outcome: Outcomes[outcome], collateral_out: collateralOut }),
        );
      let confirmed = await reconcileWithQuote(local, quoteAt);
      if (confirmed.sharesIn !== local.sharesIn) {
        market = (await fetchOnChainMarketBySimulation(id)).market;
        const [freshSold, freshOther] =
          outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
        const refreshed = solveSellForShares(freshSold, freshOther, shares, BigInt(market.fee_bps));
        if ("error" in refreshed) {
          throw new UserFacingError({
            kind: "contract",
            code: refreshed.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
            message: refreshed.error === "too-small"
              ? "That's too few shares to sell after fees."
              : "There isn't enough liquidity to sell that many shares.",
          });
        }
        local = refreshed;
        confirmed = await reconcileWithQuote(local, quoteAt);
        if (confirmed.sharesIn !== local.sharesIn) {
          const maxOut = ((freshOther - 1n) * (BPS - BigInt(market.fee_bps))) / BPS;
          let low = 0n;
          let high = maxOut + 1n;
          let lowQuote = 0n;
          let probes = 0;
          let pivot = confirmed.collateralOut;
          let pivotQuote = confirmed.sharesIn;
          if (pivotQuote <= shares) {
            low = pivot;
            lowQuote = pivotQuote;
          } else {
            high = pivot;
          }

          let step = 1n;
          while ((low === 0n || high === maxOut + 1n) && probes < 4) {
            probes++;
            if (low === 0n) {
              pivot = high > maxOut ? maxOut : high;
              const candidate = pivot > step ? pivot - step : 1n;
              pivotQuote = await quoteAt(candidate);
              if (pivotQuote <= shares) {
                low = candidate;
                lowQuote = pivotQuote;
              } else high = candidate;
            } else {
              const candidate = low + step;
              if (candidate > maxOut) break;
              pivotQuote = await quoteAt(candidate);
              if (pivotQuote > shares) high = candidate;
              else {
                low = candidate;
                lowQuote = pivotQuote;
              }
            }
            step *= 2n;
          }
          while (high - low > 1n && probes < 8) {
            probes++;
            const mid = (low + high) / 2n;
            const midQuote = await quoteAt(mid);
            if (midQuote <= shares) {
              low = mid;
              lowQuote = midQuote;
            } else high = mid;
          }
          if (low === 0n || high - low > 1n) {
            throw new UserFacingError({
              kind: "network",
              message: "The market changed while preparing your sale. Refresh the quote and try again.",
            });
          }
          confirmed = { collateralOut: low, sharesIn: lowQuote, dust: shares - lowQuote, iterations: probes };
        }
      }

      if (confirmed.sharesIn > shares) {
        throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
      }
      const maxSharesIn = [maxIn(confirmed.sharesIn, slippageBps), heldShares].reduce((a, b) => a < b ? a : b);
      const initial = await prepareSell(signer, { marketId, outcome, collateralOut: confirmed.collateralOut, maxSharesIn });
      const { prepared } = await reviewPreparedWrite(initial, params.review, () => prepareSell(signer, { marketId, outcome, collateralOut: confirmed.collateralOut, maxSharesIn }));
      const tx = prepared.tx;

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "sell",
          holder: signer.publicKey,
          marketId: String(marketId),
          outcome,
          amounts: { shares: shares.toString(), maxSharesIn: maxSharesIn.toString() },
          networkPassphrase: NETWORK_PASSPHRASE,
        });
      };

      const { value, txHash, ledger } = await runner.start(tx, confirmedAmount, onHash);
      return { sharesSold: value, collateralOut: confirmed.collateralOut, maxSharesIn, txHash, ledger, holder: signer.publicKey };
      });
    },
    onSuccess: async (d, v) => {
      // Cancel again: a focus/refetch may have started while the wallet was signing.
      await cancelTradeReads(queryClient, String(v.marketId), d.holder);
      confirmTrade(queryClient, { ...v, ...d, kind: "sell", marketId: String(v.marketId) });
      for (const key of [stellarKeys.market(String(v.marketId)), ["stellar", "markets"], stellarKeys.account(d.holder)]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export function useRedeem() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    onMutate: async (v: { marketId: bigint | string }) => cancelTradeReads(queryClient, String(v.marketId), guard().publicKey),
    onError: (error, v, context) => {
      const kind = describeError(error).kind;
      if (context && ["network", "unknown", "expired", "submission"].includes(kind)) invalidate(String(v.marketId), context.holder);
    },
    mutationFn: async ({ marketId, review }: { marketId: bigint | string; review?: PreparedWriteReview }) => {
      const signer = guard();
      return runQueuedWrite(signer, `Redeem #${marketId}`, dedupeValue("redeem", marketId), guard, async () => {
      await requireUsdcTrustline(signer.publicKey);
      throwPreflight(preflightRedeem(await fetchTradePreflightInput(toId(marketId), signer.publicKey, false)));
      const initial = await prepareRedeem(signer, marketId);
      const { prepared } = await reviewPreparedWrite(initial, review, () => prepareRedeem(signer, marketId));
      const tx = prepared.tx;

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "redeem",
          holder: signer.publicKey,
          marketId: String(marketId),
          amounts: {},
          networkPassphrase: NETWORK_PASSPHRASE,
        });
      };

      const { value, txHash, ledger } = await runner.start(tx, confirmedAmount, onHash);
      return { payout: value, txHash, ledger, holder: signer.publicKey };
      });
    },
    onSuccess: async (d, v) => {
      // Cancel again: a focus/refetch may have started while the wallet was signing.
      await cancelTradeReads(queryClient, String(v.marketId), d.holder);
      confirmTrade(queryClient, { ...v, ...d, kind: "redeem", marketId: String(v.marketId) });
      for (const key of [stellarKeys.market(String(v.marketId)), ["stellar", "markets"], stellarKeys.account(d.holder)]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export interface UsdcTransferParams {
  to: string;
  amount: bigint;
  followUp?: { type: "unlock-daily-pass"; traceId: string; amountRaw: string };
  prepared?: PreparedUsdcTransfer;
}

export interface RedeemAllController {
  discovery: RedeemDiscovery | null;
  states: Record<string, ItemState>;
  scanning: boolean;
  running: boolean;
  error: string | null;
  scan: () => Promise<void>;
  redeemAll: (review?: PreparedWriteReview) => Promise<void>;
  retryFailed: (review?: PreparedWriteReview) => Promise<void>;
  skip: (marketId: string) => void;
  cancel: () => void;
}

export function useRedeemAll(): RedeemAllController {
  const { address } = useWalletAddress();
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const [discoveryState, setDiscovery] = useState<RedeemDiscovery | null>(null);
  const [discoveryHolder, setDiscoveryHolder] = useState<string | null>(address);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [statesHolder, setStatesHolder] = useState<string | null>(address);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statesRef = useRef(states);
  const holderRef = useRef<string | null>(address);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const discovery = discoveryHolder === address ? discoveryState : null;
  const visibleStates = statesHolder === address ? states : {};

  useEffect(() => {
    holderRef.current = address;
    runningRef.current = false;
    cancelRef.current = true;
    let restored: Record<string, ItemState> = {};
    let restoreError: string | null = null;
    try {
      if (address) {
        const resume = loadRedeemAllResume(address);
        restored = Object.fromEntries(
          Object.entries(resume?.states ?? {}).map(([id, state]) => [
            id,
            state.s === "signing"
              ? { s: "queued" as const }
              : state.s === "submitting"
                ? {
                    s: "failed" as const,
                    error: state.hash
                      ? `Transaction ${state.hash} was submitted before this tab closed. Verify it on Stellar before retrying.`
                      : "The tab closed while the transaction was submitting. Verify the ledger before retrying.",
                  }
                : state,
          ]),
        );
      }
    } catch (cause) {
      restoreError = describeError(cause).message;
    }
    statesRef.current = restored;
    const reset = window.setTimeout(() => {
      setDiscovery(null);
      setDiscoveryHolder(address);
      setError(restoreError);
      setRunning(false);
      setScanning(false);
      setStates(restored);
      setStatesHolder(address);
    }, 0);
    return () => window.clearTimeout(reset);
  }, [address]);

  const commitStates = (holder: string, next: Record<string, ItemState>) => {
    if (holderRef.current !== holder) return;
    statesRef.current = next;
    setStates(next);
    setStatesHolder(holder);
    const resume: RedeemAllResume = { holder, ids: Object.keys(next), states: next };
    saveRedeemAllResume(resume);
  };

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const signer = guard();
      const holder = signer.publicKey;
      const count = simulated(await marketCore().market_count());
      const result = await discoverRedeemable(holder, count);
      if (holderRef.current !== holder) return;
      const next = { ...statesRef.current };
      for (const item of result.redeemables) {
        const id = item.marketId.toString();
        if (!next[id] || next[id].s === "failed") next[id] = { s: "queued" };
      }
      setDiscovery(result);
      setDiscoveryHolder(holder);
      commitStates(holder, next);
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      setScanning(false);
    }
  };

  const processItems = async (ids: string[], review?: PreparedWriteReview) => {
    if (runningRef.current) return;
    let signer: Signer;
    try {
      signer = guard();
      if (holderRef.current !== signer.publicKey) {
        throw new UserFacingError({ kind: "disconnected", message: "Wait for the connected wallet to finish switching before redeeming." });
      }
    } catch (cause) {
      setError(describeError(cause).message);
      return;
    }
    const holder = signer.publicKey;
    runningRef.current = true;
    cancelRef.current = false;
    setRunning(true);
    setError(null);
    const redeemedIds: string[] = [];
    try {
      for (const id of ids) {
        if (cancelRef.current || holderRef.current !== holder) break;
        const previous = statesRef.current[id];
        if (previous?.s === "redeemed" || previous?.s === "skipped") continue;
        const marketId = BigInt(id);
        try {
          const result = await runQueuedWrite(
            signer,
            `Redeem market #${id}`,
            dedupeValue("redeem", id),
            guard,
            async (attempt) =>
              redeemOnce(
                signer,
                marketId,
                () => commitStates(holder, { ...statesRef.current, [id]: { s: "signing" } }),
                review,
                attempt,
              ),
          );
          commitStates(holder, { ...statesRef.current, [id]: { s: "submitting", hash: result.txHash ?? undefined } });
          commitStates(holder, {
            ...statesRef.current,
            [id]: { s: "redeemed", payout: result.payout, hash: result.txHash },
          });
          redeemedIds.push(id);
        } catch (cause) {
          if (cancelRef.current && cause instanceof DOMException && cause.name === "AbortError") break;
          const failure = cause instanceof UserFacingError ? cause.described : describeError(cause);
          if (failure.kind === "rejected") {
            commitStates(holder, { ...statesRef.current, [id]: { s: "queued" } });
            setError(failure.message);
            cancelRef.current = true;
            break;
          }
          commitStates(holder, { ...statesRef.current, [id]: { s: "failed", error: failure.message } });
        }
      }
      if (holderRef.current === holder && redeemedIds.length) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["stellar", "markets"] }),
          queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) }),
          ...redeemedIds.flatMap((id) => [
            queryClient.invalidateQueries({ queryKey: stellarKeys.market(id) }),
            queryClient.invalidateQueries({ queryKey: stellarKeys.position(id, holder) }),
          ]),
        ]);
      }
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      runningRef.current = false;
      if (holderRef.current === holder) setRunning(false);
    }
  };

  const redeemAll = async (review?: PreparedWriteReview) => {
    const ids = (discovery?.redeemables ?? []).map((item) => item.marketId.toString());
    await processItems(ids, review);
  };

  const retryFailed = async (review?: PreparedWriteReview) => {
    const ids = Object.entries(statesRef.current)
      .filter(([, item]) => item.s === "failed")
      .map(([id]) => id);
    await processItems(ids, review);
  };

  const skip = (marketId: string) => {
    const holder = address;
    if (!holder || holderRef.current !== holder || runningRef.current) return;
    commitStates(holder, { ...statesRef.current, [marketId]: { s: "skipped" } });
  };

  const cancel = () => {
    cancelRef.current = true;
  };

  return { discovery, states: visibleStates, scanning, running, error, scan, redeemAll, retryFailed, skip, cancel };
}

/** SEP-41 transfer on the USDC SAC, signed by the connected wallet. */
export interface UsdcTransferParams {
  to: string;
  amount: bigint;
  review?: PreparedWriteReview;
  /**
   * Called on every phase of the transaction, so a screen reader can be told
   * that the wallet is waiting, that the transaction was sent and that it
   * failed. Additive: existing callers compile unchanged.
   */
  onPhase?: (phase: TxPhase) => void;
}

export function useUsdcTransfer() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    mutationFn: ({ to, amount, followUp, review, onPhase }: UsdcTransferParams) => withPinnedRpc(async () => {
      const signer = guard();
      if (amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });

      await requireUsdcTrustline(signer.publicKey);
      const initial = await prepareUsdcTransfer(signer, { to, amount });
      const { prepared } = await reviewPreparedWrite(initial, review, () => prepareUsdcTransfer(signer, { to, amount }));
      const tx = prepared.tx;

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "usdc-transfer",
          holder: signer.publicKey,
          amounts: { amount: amount.toString() },
          networkPassphrase: NETWORK_PASSPHRASE,
          followUp,
        });
      };

      const parse = () => null;

      const { txHash } = await runner.start(tx, parse, onHash, onPhase);
      if (!txHash) throw new UserFacingError({ kind: "unknown", message: "The payment was sent but no transaction hash came back." });
      return { txHash, holder: signer.publicKey };
    }),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: stellarKeys.balance(d.holder) });
    },
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

// ─── Multisig (export/import XDR) ───────────────────────────────────────────

function multisigDummySigner(sourceAccount: string): Signer {
  return {
    publicKey: sourceAccount,
    signTransaction: async () => {
      throw new Error("Multisig prepare never signs. Export the XDR and collect signatures out of band.");
    },
  };
}

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function txMeta(tx: AssembledTransaction<unknown>): {
  xdr: string;
  hash: string;
  maxTime: number;
  sourceAccount: string;
  sequence: string;
  fee: string;
  quoteLedger?: number;
} {
  const built = tx.built;
  if (!built) throw new Error("The transaction must be simulated before it can be exported.");
  const bounds = built.timeBounds;
  const maxTime = bounds?.maxTime ? Number(bounds.maxTime) : 0;
  if (!maxTime) throw new Error("The prepared transaction has no expiry. Rebuild it with a validity window.");
  return {
    xdr: tx.toXDR(),
    hash: Buffer.from(built.hash()).toString("hex").toLowerCase(),
    maxTime,
    sourceAccount: built.source,
    sequence: built.sequence,
    fee: built.fee,
    quoteLedger: tx.simulation?.latestLedger,
  };
}

async function cappedTimeout(
  requested: number | undefined,
  closeTime: bigint | undefined,
  ledgerNow: number | null,
): Promise<number> {
  const want = requested ?? MULTISIG_DEFAULT_TIMEOUT_S;
  if (closeTime === undefined || ledgerNow === null) return want;
  const remaining = Number(closeTime) - Math.floor(ledgerNow) - 10;
  if (remaining < 15) {
    throw new UserFacingError({
      kind: "contract",
      code: "MarketClosed",
      message: "This market closes too soon to prepare a multisig transaction.",
    });
  }
  return Math.min(want, remaining);
}

export type MultisigPrepareInput =
  | {
      kind: "buy";
      marketId: bigint | string;
      outcome: OutcomeTag;
      collateralIn: bigint;
      slippageBps?: number;
      sourceAccount?: string;
      timeoutInSeconds?: number;
    }
  | {
      kind: "sell";
      marketId: bigint | string;
      outcome: OutcomeTag;
      shares: bigint;
      mode?: "all" | "shares";
      slippageBps?: number;
      sourceAccount?: string;
      timeoutInSeconds?: number;
    }
  | {
      kind: "redeem";
      marketId: bigint | string;
      sourceAccount?: string;
      timeoutInSeconds?: number;
    }
  | {
      kind: "transfer";
      to: string;
      amount: bigint;
      sourceAccount?: string;
      timeoutInSeconds?: number;
    };

async function resolveSellBoundsForMultisig(
  marketId: bigint,
  outcome: OutcomeTag,
  sharesInput: bigint,
  mode: "all" | "shares" | undefined,
  slippageBps: number,
  holder: string,
): Promise<{ collateralOut: bigint; maxSharesIn: bigint; shares: bigint }> {
  const view = await fetchOnChainMarketBySimulation(marketId);
  const position = simulated(await marketCore().get_position({ market_id: marketId, holder }));
  const heldShares = outcome === "Yes" ? position.yes : position.no;
  const shares = mode === "all" ? heldShares : sharesInput;
  if (shares <= 0n) {
    throw new UserFacingError({ kind: "contract", code: "InvalidAmount", message: "Enter a share amount greater than zero." });
  }
  if (shares > heldShares) {
    throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
  }
  const [rSold, rOther] = outcome === "Yes" ? [view.market.reserve_yes, view.market.reserve_no] : [view.market.reserve_no, view.market.reserve_yes];
  const feeBps = BigInt(view.market.fee_bps);
  const local = solveSellForShares(rSold, rOther, shares, feeBps);
  if ("error" in local) {
    throw new UserFacingError({
      kind: "contract",
      code: local.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
      message:
        local.error === "too-small"
          ? "That's too few shares to sell after fees."
          : "There isn't enough liquidity to sell that many shares.",
    });
  }
  const quoteAt = async (collateralOut: bigint) =>
    simulated(await marketCore().quote_sell({ market_id: marketId, outcome: Outcomes[outcome], collateral_out: collateralOut }));
  const confirmed = await reconcileWithQuote(local, quoteAt);
  if (confirmed.sharesIn > shares) {
    throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
  }
  const maxSharesIn = [maxIn(confirmed.sharesIn, slippageBps), heldShares].reduce((a, b) => (a < b ? a : b));
  return { collateralOut: confirmed.collateralOut, maxSharesIn, shares };
}

/** Reads on-ledger multisig config for an address (signers, thresholds, sequence). */
export function useAccountAuth(address: string | null | undefined) {
  return useQuery({
    queryKey: ["stellar", "accountAuth", address ?? ""],
    enabled: Boolean(address),
    staleTime: 15_000,
    queryFn: async (): Promise<AccountAuth> => readAccountAuth(address as string, rpcServer()),
  });
}

/** Reactive view of persisted multisig sessions (sessionStorage, public data only). */
export function useMultisigSessions() {
  const [sessions, setSessions] = useState<MultisigSession[]>(() => loadMultisigSessions());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === MULTISIG_SESSIONS_KEY) setSessions(loadMultisigSessions());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const refresh = useCallback(() => setSessions(loadMultisigSessions()), []);
  const remove = useCallback(
    (id: string) => setSessions(removeMultisigSession(id)),
    [],
  );
  return { sessions, refresh, remove };
}

/**
 * Builds a long-lived, never-submitted transaction and exports its XDR.
 * Uses a 1h default window and 3% default slippage: the quote is from ledger N
 * and the trade fails with SlippageExceeded (error 12) if the price moves further.
 */
export function usePrepareMultisig() {
  const guard = useWriteGuard();
  return useMutation({
    mutationFn: async (input: MultisigPrepareInput): Promise<MultisigSession> => {
      const coordinator = guard();
      const sourceAccount =
        ("sourceAccount" in input && input.sourceAccount) || coordinator.publicKey;
      const requestedTimeout =
        ("timeoutInSeconds" in input && input.timeoutInSeconds) || MULTISIG_DEFAULT_TIMEOUT_S;
      const dummy = multisigDummySigner(sourceAccount);
      // A never-called signer proves the prepare path cannot submit: any
      // accidental signAndSend throws instead of touching the network.
      void dummy;

      let tx: AssembledTransaction<unknown>;
      let kind: MultisigSession["kind"];
      let contractId: string;
      let fn: string;
      let args: Record<string, string> = {};
      let closeTime: number | undefined;
      let quoteLedger: number | undefined;

      if (input.kind === "buy") {
        const slippage = input.slippageBps ?? MULTISIG_DEFAULT_SLIPPAGE_BPS;
        const id = toId(input.marketId);
        const [view, ledgerNow] = await Promise.all([fetchOnChainMarketBySimulation(id), fetchLedgerNow().catch(() => null)]);
        closeTime = Number(view.market.close_time);
        const timeout = await cappedTimeout(requestedTimeout, view.market.close_time, ledgerNow === null ? null : Number(ledgerNow));
        const quote = simulated(await marketCore().quote_buy({ market_id: id, outcome: Outcomes[input.outcome], collateral_in: input.collateralIn }));
        const minSharesOut = minOut(quote, slippage);
        tx = (await marketCore({ publicKey: sourceAccount, signTransaction: async () => { throw new Error("Multisig prepare never signs."); } }, { timeoutInSeconds: timeout }).buy(
          { trader: sourceAccount, market_id: id, outcome: Outcomes[input.outcome], collateral_in: input.collateralIn, min_shares_out: minSharesOut },
          { timeoutInSeconds: timeout },
        )) as unknown as AssembledTransaction<unknown>;
        simulated(tx);
        kind = "buy";
        contractId = CONTRACTS.marketCore;
        fn = "buy";
        args = {
          trader: sourceAccount,
          market_id: id.toString(),
          outcome: input.outcome,
          collateral_in: input.collateralIn.toString(),
          min_shares_out: minSharesOut.toString(),
        };
        quoteLedger = tx.simulation?.latestLedger;
      } else if (input.kind === "sell") {
        const slippage = input.slippageBps ?? MULTISIG_DEFAULT_SLIPPAGE_BPS;
        const id = toId(input.marketId);
        const [view, ledgerNow] = await Promise.all([fetchOnChainMarketBySimulation(id), fetchLedgerNow().catch(() => null)]);
        closeTime = Number(view.market.close_time);
        const timeout = await cappedTimeout(requestedTimeout, view.market.close_time, ledgerNow === null ? null : Number(ledgerNow));
        const { collateralOut, maxSharesIn } = await resolveSellBoundsForMultisig(
          id,
          input.outcome,
          input.shares,
          input.mode,
          slippage,
          sourceAccount,
        );
        tx = (await marketCore({ publicKey: sourceAccount, signTransaction: async () => { throw new Error("Multisig prepare never signs."); } }, { timeoutInSeconds: timeout }).sell(
          { trader: sourceAccount, market_id: id, outcome: Outcomes[input.outcome], collateral_out: collateralOut, max_shares_in: maxSharesIn },
          { timeoutInSeconds: timeout },
        )) as unknown as AssembledTransaction<unknown>;
        simulated(tx);
        kind = "sell";
        contractId = CONTRACTS.marketCore;
        fn = "sell";
        args = {
          trader: sourceAccount,
          market_id: id.toString(),
          outcome: input.outcome,
          collateral_out: collateralOut.toString(),
          max_shares_in: maxSharesIn.toString(),
        };
        quoteLedger = tx.simulation?.latestLedger;
      } else if (input.kind === "redeem") {
        const id = toId(input.marketId);
        const timeout = await cappedTimeout(requestedTimeout, undefined, null);
        tx = (await marketCore({ publicKey: sourceAccount, signTransaction: async () => { throw new Error("Multisig prepare never signs."); } }, { timeoutInSeconds: timeout }).redeem(
          { holder: sourceAccount, market_id: id },
          { timeoutInSeconds: timeout },
        )) as unknown as AssembledTransaction<unknown>;
        simulated(tx);
        kind = "redeem";
        contractId = CONTRACTS.marketCore;
        fn = "redeem";
        args = { holder: sourceAccount, market_id: id.toString() };
        quoteLedger = tx.simulation?.latestLedger;
      } else {
        if (input.amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
        const timeout = await cappedTimeout(requestedTimeout, undefined, null);
        tx = (await token.transfer(
          { from: sourceAccount, to: input.to, amount: input.amount },
          { publicKey: sourceAccount, signTransaction: async () => { throw new Error("Multisig prepare never signs."); } },
          undefined,
          { timeoutInSeconds: timeout },
        )) as unknown as AssembledTransaction<unknown>;
        simulated(tx, "marketCore");
        kind = "transfer";
        contractId = CONTRACTS.usdc;
        fn = "transfer";
        args = { from: sourceAccount, to: input.to, amount: input.amount.toString() };
        quoteLedger = tx.simulation?.latestLedger;
      }

      const meta = txMeta(tx);
      const server = rpcServer();
      const auth = await readAccountAuth(meta.sourceAccount, server);
      const threshold = requiredThreshold(tx.built as unknown as import("@stellar/stellar-sdk").Transaction, auth);
      const nonInvoker = nonInvokerAddresses(tx);
      const session: MultisigSession = {
        id: newSessionId(),
        kind,
        xdr: meta.xdr,
        hash: meta.hash,
        builtAt: Date.now(),
        maxTime: meta.maxTime,
        sourceAccount: meta.sourceAccount,
        sequence: meta.sequence,
        fee: meta.fee,
        contractId,
        fn,
        requiredThreshold: threshold,
        auth,
        quoteLedger: quoteLedger ?? meta.quoteLedger,
        ledgerSequence: tx.simulation?.latestLedger,
        nonInvoker,
        ...(closeTime !== undefined ? { closeTime } : {}),
        args,
      };
      upsertMultisigSession(session);
      return session;
    },
  });
}

export interface MultisigImportResult {
  session: MultisigSession;
  weight: number;
  signedBy: string[];
  unknown: number;
}

/** Merges an imported signed XDR into a session (any number of times) and persists it. */
export function useImportMultisig() {
  return useMutation({
    mutationFn: async ({ session, importedXdr }: { session: MultisigSession; importedXdr: string }): Promise<MultisigImportResult> => {
      const built = TransactionBuilder.fromXDR(session.xdr, NETWORK_PASSPHRASE) as import("@stellar/stellar-sdk").Transaction;
      const merged = mergeSigned(built, importedXdr.trim(), NETWORK_PASSPHRASE);
      const xdrOut = merged.toEnvelope().toXDR("base64");
      const hash = Buffer.from(merged.hash()).toString("hex").toLowerCase();
      if (hash !== session.hash) {
        throw new UserFacingError({ kind: "contract", message: "The imported transaction does not match the prepared one." });
      }
      const { weight, signedBy, unknown } = signatureWeight(merged, session.auth, NETWORK_PASSPHRASE);
      const next: MultisigSession = { ...session, xdr: xdrOut };
      upsertMultisigSession(next);
      return { session: next, weight, signedBy, unknown };
    },
  });
}

/**
 * Submits a multisig session once the on-ledger weight meets the threshold.
 * Re-reads the account sequence to catch `tx_bad_seq` early, rejects expired
 * or under-threshold sessions, submits via RPC and polls `getTransaction`.
 */
export function useSubmitMultisig() {
  const queryClient = useQueryClient();
  const tracker = useTxTracker();
  return useMutation({
    mutationFn: async ({ session }: { session: MultisigSession }): Promise<{ txHash: string; ledger: number }> => {
      const tx = TransactionBuilder.fromXDR(session.xdr, NETWORK_PASSPHRASE) as import("@stellar/stellar-sdk").Transaction;
      const hash = Buffer.from(tx.hash()).toString("hex").toLowerCase();
      if (hash !== session.hash) {
        throw new UserFacingError({ kind: "contract", message: "The session XDR no longer matches the prepared transaction. Prepare it again." });
      }
      const server = rpcServer();
      const freshAuth = await readAccountAuth(session.sourceAccount, server).catch((err: unknown) => {
        throw new UserFacingError(describeError(err), err);
      });
      const expectedSeq = (BigInt(session.sequence) - 1n).toString();
      if (freshAuth.sequence.toString() !== expectedSeq) {
        // Any other transaction from the source bumps the sequence and
        // invalidates the prepared one.
        throw new UserFacingError({
          kind: "stale-sequence",
          code: "txBadSeq",
          message: "Another transaction from this account changed the sequence. Prepare it again with a fresh quote.",
        });
      }
      const { weight, signedBy } = signatureWeight(tx, freshAuth, NETWORK_PASSPHRASE);
      const threshold = requiredThreshold(tx, freshAuth);
      if (weight < threshold) {
        throw new UserFacingError({
          kind: "bad-auth",
          code: "tx_bad_auth",
          message: `This account needs more signatures to meet its threshold (${weight}/${threshold}). Collect the remaining signatures before submitting.`,
        });
      }
      void signedBy;
      let latestClose = 0;
      try {
        const latest = await server.getLatestLedger();
        latestClose = Number((latest as unknown as { closeTime?: string | number }).closeTime ?? 0);
      } catch {
        latestClose = 0;
      }
      if (isExpiredByWallClock(session.maxTime) || (latestClose > 0 && isExpiredByLedger(session.maxTime, latestClose))) {
        throw new UserFacingError({
          kind: "expired",
          code: "tx_too_late",
          message: "This transaction expired before it was submitted. Prepare it again with a fresh quote.",
        });
      }
      if (session.closeTime !== undefined && latestClose > 0 && latestClose >= session.closeTime) {
        throw new UserFacingError({ kind: "contract", code: "MarketClosed", message: "This market has closed. Trading has stopped." });
      }
      let sendRes: import("@stellar/stellar-sdk").rpc.Api.SendTransactionResponse;
      try {
        sendRes = await server.sendTransaction(tx);
      } catch (err) {
        throw new UserFacingError(describeError(err), err);
      }
      if (sendRes.status === "ERROR") {
        throw new UserFacingError(describeSubmission(sendRes), sendRes);
      }
      if (sendRes.status === "TRY_AGAIN_LATER") {
        throw new UserFacingError(describeSubmission(sendRes), sendRes);
      }
      const txHash = sendRes.hash;
      tracker.track({
        hash: txHash,
        kind: session.kind === "transfer" ? "usdc-transfer" : session.kind,
        holder: session.sourceAccount,
        marketId: session.args?.market_id,
        amounts: session.args ?? {},
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const deadline = Date.now() + 60_000;
      let delay = 1000;
      for (;;) {
        if (Date.now() > deadline) {
          throw new UserFacingError({ kind: "expired", message: "Transaction expired without confirmation." });
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 5000);
        let got: import("@stellar/stellar-sdk").rpc.Api.GetTransactionResponse;
        try {
          got = await server.getTransaction(txHash);
        } catch {
          continue;
        }
        if (got.status === "SUCCESS") {
          for (const key of tradeInvalidationKeys(session.args?.market_id ?? "", session.sourceAccount)) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
          return { txHash, ledger: got.ledger };
        }
        if (got.status === "FAILED") {
          const described = describeError(`${got.resultXdr ?? ""} Transaction failed on chain`);
          const failed: import("@/lib/stellar/errors").TxDescribedError = { ...described, submission: "failed-on-chain" };
          throw new UserFacingError(failed, got);
        }
        // NOT_FOUND: keep polling until the wall-clock deadline.
      }
    },
  });
}

/** True when the connected wallet is not among the account's ed25519 signers. */
export function isCoordinatorWarning(session: MultisigSession, connectedAddress: string | null): boolean {
  if (!connectedAddress) return false;
  return !session.auth.signers.some((s) => s.type === "ed25519" && s.key === connectedAddress);
}

export { isMultisigAccount };
export type { AccountAuth, MultisigSession };
