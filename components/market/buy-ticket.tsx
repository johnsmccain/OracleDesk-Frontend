"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MultisigReview } from "@/components/multisig-review";
import { PendingValue } from "@/components/pending-value";
import { SourceTag } from "@/components/ui/source-tag";
import { TxReview, shouldSkipTxReview } from "@/components/tx-review";
import { TxLink } from "@/components/ui/tx-link";
import { useAnnounce, useFocusReturn } from "@/components/ui/announcer";
import { announcementPoliteness, failureMessage, txMessages } from "@/lib/a11y/tx-messages";
import { useHealth } from "@/lib/health/HealthProvider";
import {
  useAccountAuth,
  useAccountReserve,
  useBuy,
  useEnableUsdc,
  useExactBuyQuote,
  useLedgerNow,
  useMarketConfig,
  useOnChainMarket,
  usePosition,
  usePositionState,
  usePrepareBuy,
  usePrepareMultisig,
  useQuoteBuy,
  useUsdcBalance,
  useUsdcBalanceState,
  useUsdcTrustline,
} from "@/lib/hooks/useStellar";
import { useWalletActions, useWalletAddress, useWalletNetwork } from "@/lib/contexts/WalletContext";
import { useSettings } from "@/lib/settings/useSettings";
import { MIN_TX_TIMEOUT_S, SAFETY_MARGIN_S } from "@/lib/stellar/deadline";
import { isStale } from "@/lib/stellar/health";
import { useLedgerNow as useLedgerClock } from "@/lib/stellar/ledger-clock";
import { isMultisigAccount, MULTISIG_DEFAULT_SLIPPAGE_BPS, type MultisigSession } from "@/lib/stellar/multisig";
import type { ReviewModel } from "@/lib/stellar/tx-decode";
import type { TxPhase } from "@/lib/stellar/tx-lifecycle";
import { bpsToPercent, formatUsdc, formatXlm, maxIn, minOut, tryParseUsdc } from "@/lib/stellar/units";

/** A chain read older than this must be refreshed before a trade is signed. */
const MARKET_STALE_AFTER_SEC = 60;

export interface BuyTicketProps {
  /** The on-chain market id, as a decimal string. */
  onChainMarketId: string;
  /** Which side the ticket is buying. */
  side: "Yes" | "No";
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function renderTxPhase(phase: TxPhase): string | null {
  switch (phase.name) {
    case "building":
      return null;
    case "simulating":
      return "Simulating transaction…";
    case "awaiting-signature":
      return "Waiting for your wallet…";
    case "submitting":
      return "Sending to the network…";
    case "pending":
      return "Waiting for a ledger…";
    case "confirmed":
      return "Transaction confirmed.";
    case "failed":
      return phase.error.message;
    case "expired":
      return "Transaction expired without confirmation.";
  }
}

/**
 * The buy form of the quick-view modal.
 *
 * It owns the amount input, the quote and the trade itself, so typing in the
 * amount field re-renders this component and nothing else in the modal. The
 * wallet is read through the narrow context hooks, so a wallet change that
 * does not affect the trade does not re-render the ticket either.
 */
export function BuyTicket({ onChainMarketId, side }: BuyTicketProps) {
  const { address, isConnected } = useWalletAddress();
  const { isWrongNetwork } = useWalletNetwork();
  const { openModal } = useWalletActions();
  const health = useHealth();

  // Saved in /settings; useSyncExternalStore makes it available before the
  // first visible quote even though pages are statically prerendered.
  const { settings } = useSettings(address);
  const slippageBps = settings.slippageBps;

  const chain = useOnChainMarket(onChainMarketId);
  const view = chain.data;
  const position = usePosition(onChainMarketId, address);
  const balance = useUsdcBalance(address);
  const reserve = useAccountReserve(address);
  const positionState = usePositionState(onChainMarketId, address);
  const balanceState = useUsdcBalanceState(address);
  const config = useMarketConfig();
  const ledgerNow = useLedgerNow();
  const ledger = useLedgerClock();
  const trustline = useUsdcTrustline(address);
  const enableUsdc = useEnableUsdc();
  const trustlineMissing = trustline.data?.kind === "missing";
  const trustlineUnauthorized = trustline.data?.kind === "present" && !trustline.data.authorized;
  const buy = useBuy();
  const accountAuth = useAccountAuth(address);
  const isMultisig = accountAuth.data ? isMultisigAccount(accountAuth.data) : false;
  const [multisigMode, setMultisigMode] = useState(false);
  const [multisigSession, setMultisigSession] = useState<MultisigSession | null>(null);
  const [multisigStatus, setMultisigStatus] = useState<string | null>(null);
  const prepareMultisig = usePrepareMultisig();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const [buyMode, setBuyMode] = useState<"usdc" | "shares">("usdc");
  const [amountInput, setAmountInput] = useState("10");
  const [buyResult, setBuyResult] = useState<{ message: string; txHash?: string | null } | null>(null);
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const buyButtonRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const announce = useAnnounce();
  const focusReturn = useFocusReturn();

  // The review and multisig dialogs are portalled to <body>: the modal card
  // is animated, so a transformed ancestor would clip a `position: fixed`
  // overlay rendered inside it.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setPortalReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const amountRaw = tryParseUsdc(amountInput);
  const debouncedAmount = useDebounced(amountRaw, 400);
  const exactQuote = useExactBuyQuote(onChainMarketId, side, buyMode === "shares" ? debouncedAmount : null);
  const spendRaw = buyMode === "shares" ? exactQuote.data?.collateralIn ?? null : amountRaw;
  const quote = useQuoteBuy(onChainMarketId, side, buyMode === "usdc" ? debouncedAmount : spendRaw);
  const prepareBuy = usePrepareBuy({ marketId: onChainMarketId, outcome: side, collateralIn: spendRaw, slippageBps, holder: address });
  const fees = prepareBuy.data?.fees;
  const isUnfunded = reserve.data?.funded === false;
  const isInsufficientXlm = !!(reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable);
  const xlmDeficit = reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable ? fees.totalFee - reserve.data.spendable : 0n;

  const closeReview = useCallback((approved: boolean) => {
    setReviewModel(null);
    reviewResolver.current?.(approved);
    reviewResolver.current = null;
  }, []);
  const review = useCallback(async (_prepared: unknown, model: ReviewModel, changedFrom?: ReviewModel, force = false) => {
    if (!force && shouldSkipTxReview()) return true;
    setReviewModel({ model, changedFrom });
    return new Promise<boolean>(resolve => {
      reviewResolver.current = resolve;
    });
  }, []);
  useEffect(() => () => {
    reviewResolver.current?.(false);
  }, []);

  const chainStatus = view?.market.status;
  // Use a timer-backed timestamp so freshness changes are reflected without impure render reads.
  const secondsToClose = ledger.now !== null && view ? Number(view.market.close_time - BigInt(Math.floor(ledger.now))) : null;
  const safeToTrade = secondsToClose !== null && secondsToClose > SAFETY_MARGIN_S + MIN_TX_TIMEOUT_S;
  const isOpen = chainStatus?.tag === "Open" && Number(view?.market.close_time ?? 0) * 1000 > chain.dataUpdatedAt;
  const isFresh = (updatedAt: number, maxAge: number) => now !== null && now >= updatedAt && now - updatedAt <= maxAge;

  const action = `Buy ${side.toUpperCase()} shares`;

  /**
   * The wallet takes the focus when it opens, and drops it when it closes.
   * Capture it before the prompt, put it back afterwards, and say what is
   * happening at every step.
   */
  const onPhase = useCallback(
    (phase: TxPhase) => {
      switch (phase.name) {
        case "awaiting-signature":
          focusReturn.capture();
          announce(txMessages.awaitingSignature(action), {
            dedupeKey: `buy:${onChainMarketId}:awaiting`,
          });
          return;
        case "submitting":
          announce(txMessages.submitted(action), {
            dedupeKey: `buy:${onChainMarketId}:submitted`,
          });
          return;
        case "failed":
          announce(failureMessage(action, phase.error), {
            politeness: announcementPoliteness(phase.error.kind),
            dedupeKey: `buy:${onChainMarketId}:failed`,
          });
          focusReturn.restore(buyButtonRef.current);
          return;
        case "expired":
          announce(txMessages.failed({ kind: "expired", message: "The transaction expired before it was confirmed." }), {
            politeness: "assertive",
            dedupeKey: `buy:${onChainMarketId}:expired`,
          });
          focusReturn.restore(buyButtonRef.current);
          return;
        default:
          return;
      }
    },
    [action, announce, focusReturn, onChainMarketId],
  );

  const handleBuy = async () => {
    if (!isConnected) {
      void openModal();
      return;
    }
    if (trustlineMissing) {
      setBuyResult({ message: "Enable your USDC trustline below, then click Buy again." });
      return;
    }
    if (trustlineUnauthorized) {
      setBuyResult({ message: "The issuer hasn't authorized your USDC trustline." });
      return;
    }
    if (isWrongNetwork) {
      setBuyResult({ message: "Switch your wallet to Stellar Testnet to place this trade." });
      return;
    }
    if (!amountRaw || amountRaw <= 0n) {
      setBuyResult({ message: buyMode === "usdc" ? "Enter an amount like 10 or 2.5." : "Enter a share amount greater than zero." });
      return;
    }
    if (ledger.now === null) {
      setBuyResult({ message: "Checking market time…" });
      return;
    }
    if (!safeToTrade) {
      setBuyResult({ message: "This market closes too soon to safely place a trade." });
      return;
    }
    if (health.rpc.status === "down") {
      setBuyResult({ message: "Stellar RPC isn't responding; the trade can't be simulated." });
      return;
    }
    if (now !== null && view && isStale(chain.dataUpdatedAt, now, MARKET_STALE_AFTER_SEC)) {
      setBuyResult({ message: "Refreshing the price before you trade…" });
      await chain.refetch();
    }
    setBuyResult(null);
    try {
      const result = await buy.mutateAsync({
        marketId: onChainMarketId,
        outcome: side,
        collateralIn: spendRaw ?? 0n,
        review,
        slippageBps,
        prepared: prepareBuy.data,
        onPhase,
      });
      setBuyResult({
        message: `Bought ${formatUsdc(result.sharesOut, { maxDecimals: 2 })} ${side.toUpperCase()} shares.`,
        txHash: result.txHash,
      });
      announce(txMessages.confirmed({ action, amount: result.sharesOut, unit: "shares" }), {
        dedupeKey: `buy:${onChainMarketId}:confirmed`,
      });
      focusReturn.restore(resultRef.current ?? buyButtonRef.current);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The trade didn't go through.";
      setBuyResult({ message });
      focusReturn.restore(buyButtonRef.current);
    }
  };

  const handleEnableUsdc = async () => {
    setBuyResult({ message: "Checking XLM reserve, then opening your wallet…" });
    try {
      await enableUsdc.mutateAsync();
      setBuyResult({ message: "USDC is enabled. Review your amount and click Buy to submit the trade." });
    } catch (err) {
      setBuyResult({ message: err instanceof Error ? err.message : "Couldn't enable USDC." });
    }
  };

  const handlePrepareMultisig = async () => {
    if (!isConnected) {
      void openModal();
      return;
    }
    if (isWrongNetwork) {
      setMultisigStatus("Switch your wallet to Stellar Testnet to prepare this trade.");
      return;
    }
    if (!spendRaw || spendRaw <= 0n) {
      setMultisigStatus(buyMode === "usdc" ? "Enter an amount like 10 or 2.5." : "Enter a share amount greater than zero.");
      return;
    }
    if (buyMode === "shares") {
      setMultisigStatus("Multisig prepare currently supports USDC amounts. Switch to USDC and try again.");
      return;
    }
    setMultisigStatus(null);
    try {
      const session = await prepareMultisig.mutateAsync({
        kind: "buy",
        marketId: onChainMarketId,
        outcome: side,
        collateralIn: spendRaw,
        slippageBps: MULTISIG_DEFAULT_SLIPPAGE_BPS,
        sourceAccount: address ?? undefined,
        timeoutInSeconds: 3600,
      });
      setMultisigSession(session);
    } catch (err) {
      setMultisigStatus(err instanceof Error ? err.message : "Couldn't prepare the multisig transaction.");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="inline-flex rounded border border-outline-variant p-0.5" role="group" aria-label="Buy amount unit">
          <button type="button" aria-pressed={buyMode === "usdc"} onClick={() => setBuyMode("usdc")} className={`px-2 py-1 text-[10px] rounded ${buyMode === "usdc" ? "bg-primary text-primary-foreground" : "text-on-surface-variant"}`}>USDC</button>
          <button type="button" aria-pressed={buyMode === "shares"} onClick={() => setBuyMode("shares")} className={`px-2 py-1 text-[10px] rounded ${buyMode === "shares" ? "bg-primary text-primary-foreground" : "text-on-surface-variant"}`}>Shares</button>
        </div>
        <label htmlFor="buy-amount" className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] shrink-0">
          Amount ({buyMode === "usdc" ? "USDC" : `${side.toUpperCase()} shares`})
        </label>
        <input
          id="buy-amount"
          inputMode="decimal"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          className="flex-1 bg-surface border border-outline-variant rounded p-2 font-data-mono text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          ref={buyButtonRef}
          type="button"
          onClick={handleBuy}
          disabled={
            buy.isPending ||
            (isConnected && !isOpen) ||
            (isConnected && isUnfunded) ||
            (isConnected && isInsufficientXlm)
          }
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-label-caps text-label-caps font-bold disabled:opacity-50"
        >
          {!isConnected
            ? "Connect"
            : buy.isPending
            ? (buy.phase.name === "awaiting-signature" ? "Signing…" : "Buying…")
            : isUnfunded
            ? "Fund Account"
            : isInsufficientXlm
            ? "Insufficient XLM"
            : `Buy ${side.toUpperCase()}`}
        </button>
      </div>
      <div className="flex justify-between text-[11px] font-data-mono text-on-surface-variant">
        <span>
          {amountRaw === null
            ? buyMode === "usdc" ? "Enter an amount like 10 or 2.5" : "Enter a share amount"
            : buyMode === "shares" && exactQuote.data
              ? `Costs ≈ ${formatUsdc(exactQuote.data.collateralIn, { maxDecimals: 2 })} USDC (fee ${formatUsdc(exactQuote.data.fee, { maxDecimals: 2 })}), at most ${formatUsdc(maxIn(exactQuote.data.collateralIn, slippageBps), { maxDecimals: 2 })} with ${bpsToPercent(slippageBps)} slippage`
              : buyMode === "shares" && exactQuote.error
                ? exactQuote.error.message
                : buyMode === "shares" && exactQuote.isFetching
                  ? "Quoting exact share amount…"
                  : quote.data !== undefined
              ? `≈ ${formatUsdc(quote.data, { maxDecimals: 2 })} shares, at least ${formatUsdc(minOut(quote.data, slippageBps), { maxDecimals: 2 })} (${bpsToPercent(slippageBps)} slippage)`
              : quote.error ? quote.error.message : quote.isFetching ? "Quoting…" : ""}
        </span>
        {balance.data !== undefined && <span>Balance {formatUsdc(balance.data, { maxDecimals: 2, grouping: true })}<PendingValue state={balanceState.data} /></span>}
      </div>

      {/* Network fee & reserve row */}
      {isConnected && (
        <div
          className="flex justify-between items-center text-[11px] font-data-mono text-on-surface-variant"
          title={fees ? `Inclusion: ${formatXlm(fees.inclusionFee)} XLM · Resource: ${formatXlm(fees.resourceFee)} XLM (assumes the network base reserve of 0.5 XLM)` : "assumes the network base reserve of 0.5 XLM"}
        >
          <span>
            Network fee {fees ? `≈ ${formatXlm(fees.totalFee)} XLM` : prepareBuy.isLoading ? "≈ calculating…" : "—"} ·{" "}
            {reserve.isLoading
              ? "checking XLM…"
              : reserve.isError
              ? "couldn't check XLM balance"
              : reserve.data && !reserve.data.funded
              ? "unfunded"
              : reserve.data
              ? `spendable ${formatXlm(reserve.data.spendable, { maxDecimals: 1 })} XLM`
              : "spendable —"}
          </span>
          {fees && (
            <span className="text-[10px] text-outline">
              (inclusion {formatXlm(fees.inclusionFee)} + resource {formatXlm(fees.resourceFee)})
            </span>
          )}
        </div>
      )}

      {/* Blocking warnings */}
      {isConnected && isUnfunded && (
        <p className="text-xs text-error font-medium" role="alert">
          Fund this account with XLM first.
        </p>
      )}
      {isConnected && isInsufficientXlm && xlmDeficit !== null && (
        <p className="text-xs text-error font-medium" role="alert">
          You need about {formatXlm(xlmDeficit)} more XLM to pay the network fee.
        </p>
      )}

      {!isOpen && view && (
        <p className="text-[11px] text-on-surface-variant">This market is closed to trading.</p>
      )}
      {ledger.now === null && <p className="text-[11px] text-on-surface-variant">Checking market time…</p>}
      {isOpen && !safeToTrade && <p className="text-[11px] text-on-surface-variant">Trading is disabled this close to the market deadline.</p>}
      {trustlineMissing && !isWrongNetwork && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3 space-y-2">
          <p className="text-xs text-on-surface-variant">
            Enable USDC once to buy on Stellar. This creates a trustline and locks one base reserve (typically 0.5 XLM); it does not submit your trade.
          </p>
          <button type="button" onClick={handleEnableUsdc} disabled={enableUsdc.isPending} className="bg-primary text-primary-foreground px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50">
            {enableUsdc.isPending ? "Enabling…" : "Enable USDC"}
          </button>
        </div>
      )}
      {trustlineUnauthorized && <p className="text-[11px] text-error">The issuer hasn&apos;t authorized your USDC trustline.</p>}
      {position.data && (position.data.yes > 0n || position.data.no > 0n || positionState.data?.provisional || positionState.data?.awaitingRpc) && (
        <p className="text-[11px] font-data-mono text-on-surface">
          Your position: {formatUsdc(position.data.yes, { maxDecimals: 2 })} YES · {formatUsdc(position.data.no, { maxDecimals: 2 })} NO
          <PendingValue state={positionState.data} fallback={<SourceTag source="chain" ledger={view?.ledger} readAt={chain.dataUpdatedAt} />} />
        </p>
      )}

      {/* Observable tx lifecycle phase */}
      {buy.isPending && (
        <div className="text-xs text-on-surface-variant flex items-center gap-1.5" role="status">
          <span>{renderTxPhase(buy.phase) ?? "Processing transaction…"}</span>
          {"hash" in buy.phase && buy.phase.hash && <TxLink hash={buy.phase.hash} />}
        </div>
      )}

      {/* Result or status message */}
      {!buy.isPending && buyResult && (
        <p ref={resultRef} tabIndex={-1} className="text-xs text-on-surface-variant">
          {buyResult.message}
          {buyResult.txHash && (
            <>
              {" "}
              <TxLink hash={buyResult.txHash} />
            </>
          )}
        </p>
      )}

      {/* Multisig path */}
      {isConnected && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3 space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={multisigMode}
              onChange={(e) => setMultisigMode(e.target.checked)}
            />
            Use multisig (export XDR for co-signers)
          </label>
          {accountAuth.isLoading && <p className="text-[11px] text-on-surface-variant">Checking multisig thresholds…</p>}
          {isMultisig && !multisigMode && (
            <p className="text-[11px] text-on-surface-variant">
              This account needs multiple signatures (medium threshold {accountAuth.data?.med}, {accountAuth.data?.signers.length} signers). For treasuries, use “Prepare for multisig”.
            </p>
          )}
          {(multisigMode || isMultisig) && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={handlePrepareMultisig}
                disabled={prepareMultisig.isPending || !spendRaw || spendRaw <= 0n}
                className="bg-surface-container px-3 py-2 rounded-lg text-xs font-bold border border-outline-variant disabled:opacity-50"
              >
                {prepareMultisig.isPending ? "Preparing…" : "Prepare for multisig"}
              </button>
              <p className="text-[11px] text-on-surface-variant">
                Builds with a 1-hour window and 3% slippage. Quote is from the current ledger; the trade fails with SlippageExceeded (error 12) if the price moves further.
              </p>
              {multisigStatus && <p className="text-xs text-on-surface-variant" role="status">{multisigStatus}</p>}
            </div>
          )}
        </div>
      )}

      {portalReady && reviewModel && createPortal(
        <TxReview
          model={reviewModel.model}
          changedFrom={reviewModel.changedFrom}
          onConfirm={() => closeReview(true)}
          onCancel={() => closeReview(false)}
        />,
        document.body,
      )}
      {portalReady && multisigSession && createPortal(
        <MultisigReview
          session={multisigSession}
          onClose={() => setMultisigSession(null)}
          onUpdated={(next) => setMultisigSession(next)}
        />,
        document.body,
      )}
    </div>
  );
}
