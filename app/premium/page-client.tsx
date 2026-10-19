"use client";

import { TxReview, TxReviewPreferenceControl, shouldSkipTxReview } from "@/components/tx-review";
import type { ReviewModel } from "@/lib/stellar/tx-decode";
import { useSubmitQueueState } from "@/lib/stellar/submit-queue";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";

import { useWallet } from "@/lib/contexts/WalletContext";
import { useUsdcTransfer, useAccountReserve, usePrepareUsdcTransfer, useAccountAuth, usePrepareMultisig } from "@/lib/hooks/useStellar";
import { PAYMENTS_RECIPIENT, NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import { formatUsdc, parseUsdc } from "@/lib/stellar/units";
import { TxPhase } from "@/lib/stellar/tx-lifecycle";
import { isMultisigAccount, type MultisigSession } from "@/lib/stellar/multisig";
import { MultisigReview } from "@/components/multisig-review";
import { PendingPaymentCard } from "@/components/pending-payment-card";
import { TxLink } from "@/components/ui/tx-link";
import { useAnnounce, useFocusReturn } from "@/components/ui/announcer";
import { announcementPoliteness, failureMessage, txMessages } from "@/lib/a11y/tx-messages";
import { isUnfinishedPayment, listPending, removePending, savePending, type PendingPayment } from "@/lib/payments/pending";
import { verifyPendingPayment, type VerifyResult } from "@/lib/payments/verify";
import { DAILY_PASS_TRACE_PLACEHOLDER } from "@/lib/api/traces";

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

const DAILY_PASS_PRICE_RAW = parseUsdc(process.env.NEXT_PUBLIC_DAILY_PASS_PRICE_USDC || "0.5");

interface Tier {
  name: string;
  priceRaw: bigint | null;
  priceStr: string;
  period: string;
  description: string;
  features: { text: string; included: boolean }[];
  buttonText: string;
  featured?: boolean;
}

const tiers: Tier[] = [
  {
    name: "Free",
    priceRaw: 0n,
    priceStr: "$0",
    period: "",
    description: "Standard market access for retail observers.",
    buttonText: "CURRENT PLAN",
    features: [
      { text: "Basic Market View", included: true },
      { text: "100 Trace Depth", included: true },
      { text: "Priority Latency", included: false },
      { text: "Advanced API Access", included: false },
    ],
  },
  {
    name: "Pro",
    priceRaw: DAILY_PASS_PRICE_RAW,
    priceStr: `${formatUsdc(DAILY_PASS_PRICE_RAW, { minDecimals: 2 })} USDC`,
    period: "/24 hours",
    description: "Full reasoning traces for 24 hours, paid in USDC on Stellar.",
    buttonText: "GET A DAILY PASS",
    featured: true,
    features: [
      { text: "Full Market Depth", included: true },
      { text: "5,000 Trace Depth", included: true },
      { text: "Priority Data Routing", included: true },
      { text: "Read-Only API Access", included: true },
    ],
  },
  {
    name: "Institutional",
    priceRaw: null,
    priceStr: "—",
    period: "",
    description: "The terminal for firms and high-volume funds. Not available to buy yet.",
    buttonText: "NOT AVAILABLE YET",
    features: [
      { text: "Unlimited Market Depth", included: true },
      { text: "50,000 Trace Depth", included: true },
      { text: "Zero-Latency Dedicated Relay", included: true },
      { text: "Full Read/Write API", included: true },
    ],
  },
];

const features = [
  { name: "Trace Depth (Nodes)", free: "100", pro: "5,000", institutional: "50,000" },
  { name: "Latency Priority", free: "Standard (Shared)", pro: "High (Priority Queue)", institutional: "Ultra (Dedicated Relay)" },
  { name: "API Endpoints", free: "None", pro: "Read-only (Standard)", institutional: "Read/Write (Websockets)" },
  { name: "AI Insights (Oracle)", free: "Daily Summaries", pro: "Real-time Reasoning", institutional: "Predictive Modeling" },
];

export default function PremiumPageClient() {
  const { address, isConnected, isWrongNetwork, openModal, ensureSession } = useWallet();
  const transfer = useUsdcTransfer();
  const submitQueue = useSubmitQueueState(address);
  const queryClient = useQueryClient();
  const reserve = useAccountReserve(address);
  const [, setPendingVersion] = useState(0);
  const refreshPending = useCallback(() => setPendingVersion((version) => version + 1), []);
  const pendingPayments = address ? listPending(address, NETWORK_PASSPHRASE) : [];
  const visiblePending = pendingPayments.filter((payment) => payment.state !== "verified");
  const hasUnfinishedPayment = pendingPayments.some(isUnfinishedPayment);

  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"usdc" | "card">("usdc");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTxHash, setStatusTxHash] = useState<string | null>(null);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const payButtonRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const announce = useAnnounce();
  const focusReturn = useFocusReturn();
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const accountAuth = useAccountAuth(address);
  const isMultisig = accountAuth.data ? isMultisigAccount(accountAuth.data) : false;
  const [multisigMode, setMultisigMode] = useState(false);
  const [multisigSession, setMultisigSession] = useState<MultisigSession | null>(null);
  const prepareMultisig = usePrepareMultisig();
  const waitingForTransfer =
    submitQueue.waiting.some((job) => job.label === "USDC transfer") ||
    (submitQueue.lockWaiting && submitQueue.running?.label === "USDC transfer");

  const reviewPreparedTransfer = useCallback(async (_prepared: unknown, model: ReviewModel, changedFrom?: ReviewModel, forceReview = false) => {
    if (!forceReview && shouldSkipTxReview()) return true;
    return new Promise<boolean>((resolve) => {
      reviewResolver.current = resolve;
      setReviewModel({ model, changedFrom });
    });
  }, []);
  const closeReview = useCallback((approved: boolean) => {
    setReviewModel(null);
    const resolve = reviewResolver.current;
    reviewResolver.current = null;
    resolve?.(approved);
  }, []);

  useEffect(() => () => {
    const resolve = reviewResolver.current;
    reviewResolver.current = null;
    resolve?.(false);
  }, []);

  const prepareTransfer = usePrepareUsdcTransfer({
    to: PAYMENTS_RECIPIENT,
    amount: selectedTier?.priceRaw ?? null,
    holder: address,
  });

  const resumePayment = useCallback(
    async (payment: PendingPayment, signIn?: () => Promise<boolean>): Promise<VerifyResult> => {
      const result = await verifyPendingPayment(payment, { signIn, onUpdate: refreshPending });
      refreshPending();
      if (result === "verified") {
        queryClient.invalidateQueries({ queryKey: ["trace-payments"] });
        queryClient.invalidateQueries({ queryKey: ["trace"] });
        queryClient.invalidateQueries({ queryKey: ["traces"] });
      }
      return result;
    },
    [queryClient, refreshPending],
  );

  useEffect(() => {
    if (!address || isWrongNetwork) return;
    const unfinished = listPending(address, NETWORK_PASSPHRASE).filter(
      (payment) => payment.state === "submitted" || payment.state === "verifying",
    );
    if (unfinished.length === 0) return;
    // Resume after this effect body has returned. Verifying a payment updates
    // the pending list, and doing that synchronously inside the effect would
    // be a cascading render.
    const timer = window.setTimeout(() => {
      for (const payment of unfinished) void resumePayment(payment);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [address, isWrongNetwork, resumePayment]);

  const fees = prepareTransfer.data?.fees;
  const isUnfunded = Boolean(reserve.data && !reserve.data.funded);
  const isInsufficientXlm = Boolean(
    reserve.data?.funded &&
    fees &&
    reserve.data.spendable < fees.totalFee
  );
  const xlmDeficit = (reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable)
    ? fees.totalFee - reserve.data.spendable
    : null;

  const openCheckout = async (tier: Tier) => {
    if (!tier.priceRaw) return;
    if (!isConnected && !(await openModal())) return;
    setStatusMessage(null);
    setSelectedTier(tier);
  };

  const handlePrepareMultisigTransfer = async () => {
    if (!selectedTier?.priceRaw || !address) return;
    try {
      const session = await prepareMultisig.mutateAsync({
        kind: "transfer",
        to: PAYMENTS_RECIPIENT,
        amount: selectedTier.priceRaw,
        sourceAccount: address,
        timeoutInSeconds: 3600,
      });
      setMultisigSession(session);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Couldn't prepare the multisig payment.");
    }
  };

  const handlePayment = async () => {
    if (!selectedTier?.priceRaw || !address) return;

    if (paymentMethod === "card") {
      setStatusMessage("Card payments aren't available. Pay with USDC instead.");
      return;
    }
    if (isWrongNetwork) {
      setStatusMessage("Switch your wallet to Stellar Testnet to complete the purchase.");
      return;
    }
    if (listPending(address, NETWORK_PASSPHRASE).some(isUnfinishedPayment)) {
      setStatusMessage("Finish your previous payment before making another one.");
      return;
    }

    setIsSubmitting(true);
    setPaymentComplete(false);
    setStatusTxHash(null);
    let txHash: string | null = null;
    try {
      setStatusMessage("One more signature: this logs you in to OracleDesk and doesn't move funds.");
      announce(txMessages.awaitingSignature("Daily pass payment"), { dedupeKey: "premium:signin" });
      if (!(await ensureSession())) {
        setStatusMessage("You need to sign in with your wallet before paying.");
        focusReturn.restore(payButtonRef.current);
        return;
      }

      setStatusMessage(null);
      const sent = await transfer.mutateAsync({
        to: PAYMENTS_RECIPIENT,
        amount: selectedTier.priceRaw,
        prepared: prepareTransfer.data,
        review: reviewPreparedTransfer,
        followUp: {
          type: "unlock-daily-pass",
          traceId: DAILY_PASS_TRACE_PLACEHOLDER,
          amountRaw: selectedTier.priceRaw.toString(),
        },
        onPhase: (phase) => {
          if (phase.name === "awaiting-signature") {
            focusReturn.capture();
            announce(txMessages.awaitingSignature("Daily pass payment"), { dedupeKey: "premium:awaiting" });
          } else if (phase.name === "submitting") {
            announce(txMessages.submitted("Daily pass payment"), { dedupeKey: "premium:submitted" });
          } else if (phase.name === "failed") {
            announce(failureMessage("Daily pass payment", phase.error), {
              politeness: announcementPoliteness(phase.error.kind),
              dedupeKey: "premium:failed",
            });
            focusReturn.restore(payButtonRef.current);
          }
        },
      });
      txHash = sent.txHash.toLowerCase();

      const payment: PendingPayment = {
        txHash,
        kind: "DAILY_PASS",
        amountRaw: selectedTier.priceRaw.toString(),
        from: sent.holder,
        recipient: PAYMENTS_RECIPIENT,
        networkPassphrase: NETWORK_PASSPHRASE,
        createdAt: Date.now(),
        attempts: 0,
        state: "submitted",
      };
      const saved = savePending(payment);
      refreshPending();

      setStatusMessage("Payment sent. Waiting for OracleDesk to verify it on-chain…");
      setStatusTxHash(txHash);
      announce(txMessages.backendFollowUp("Daily pass payment"), { dedupeKey: "premium:verifying" });
      const result = await resumePayment(payment, ensureSession);
      if (!saved) {
        setStatusMessage("Couldn't save this payment on this device. Keep the transaction link below as your receipt.");
        setStatusTxHash(txHash);
        announce(txMessages.failed({ kind: "unknown", message: "Couldn't save this payment on this device. Keep the transaction link as your receipt." }), {
          politeness: "assertive",
          dedupeKey: "premium:unsaved",
        });
      } else if (result === "verified") {
        setStatusMessage("Your daily pass is active for 24 hours.");
        setStatusTxHash(txHash);
        setPaymentComplete(true);
        announce(txMessages.confirmed({ action: "Daily pass payment", amount: selectedTier.priceRaw, unit: "USDC" }), {
          dedupeKey: "premium:confirmed",
        });
        focusReturn.restore(resultRef.current ?? payButtonRef.current);
      } else {
        setStatusMessage("Payment received. Activation is still pending and is listed above; you don't need to pay again.");
        setStatusTxHash(txHash);
        announce(txMessages.backendFollowUp("Daily pass payment"), { dedupeKey: "premium:pending" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment failed. Please try again.";
      setStatusMessage(
        txHash === null ? `${message} If funds left your wallet, check its history before paying again.` : message,
      );
      announce(txMessages.failed({ kind: "unknown", message }), {
        politeness: "assertive",
        dedupeKey: "premium:failed",
      });
      focusReturn.restore(payButtonRef.current);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex-grow">
      <section className="py-16 bg-surface-container-low border-b border-outline-variant">
        <div className="max-w-container-max-width mx-auto px-gutter text-center">
          <span className="font-label-caps text-label-caps text-primary tracking-widest bg-primary-container/10 px-3 py-1 rounded-full mb-6 inline-block">
            INSTITUTIONAL GRADE
          </span>
          <h1 className="font-display-lg text-display-lg mb-4 text-4xl md:text-5xl">Elevate Your Analytical Edge</h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mx-auto">
            Access institutional-grade market prediction tools, sub-millisecond data latency, and advanced AI reasoning for high-stakes decision making.
          </p>
        </div>
      </section>

      <section className="py-12 px-gutter max-w-container-max-width mx-auto">
        {visiblePending.length > 0 && (
          <div className="mb-8 space-y-3">
            <h2 className="font-headline-sm text-headline-sm">Unfinished payments</h2>
            {visiblePending.map((payment) => (
              <PendingPaymentCard
                key={payment.txHash}
                payment={payment}
                busy={payment.state === "verifying"}
                wrongNetwork={isWrongNetwork}
                onRetry={() => void resumePayment(payment, ensureSession)}
                onDismiss={() => {
                  removePending(payment.txHash);
                  refreshPending();
                }}
              />
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 pt-8">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`bg-white border rounded-xl p-8 flex flex-col transition-all duration-300 relative ${
                tier.featured
                  ? "border-primary border-2 shadow-lg md:scale-105 z-10"
                  : "border-outline-variant hover:border-primary/50 shadow-sm"
              }`}
            >
              {tier.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-on-primary px-3 py-1 rounded-full font-label-caps text-label-caps text-[10px]">
                  MOST POPULAR
                </div>
              )}
              <div className="mb-8">
                <h3 className="font-headline-sm text-headline-sm mb-2">{tier.name}</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="font-display-lg text-display-lg text-4xl">{tier.priceStr}</span>
                  {tier.period && <span className="text-on-surface-variant font-body-md">{tier.period}</span>}
                </div>
                <p className="text-on-surface-variant font-body-md h-12">{tier.description}</p>
              </div>
              <ul className="space-y-4 flex-grow mb-8">
                {tier.features.map((feature, idx) => (
                  <li
                    key={idx}
                    className={`flex items-center gap-3 font-body-md ${
                      !feature.included ? "opacity-40" : ""
                    }`}
                  >
                    <span className="material-symbols-outlined text-primary text-lg">
                      {feature.included ? "check_circle" : "cancel"}
                    </span>
                    {feature.text}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => openCheckout(tier)}
                disabled={tier.priceRaw === null || (Boolean(tier.priceRaw) && hasUnfinishedPayment)}
                className={`w-full py-3 rounded-lg font-label-caps text-label-caps transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  tier.name === "Free"
                    ? "border border-outline hover:bg-surface-container"
                    : tier.featured
                    ? "bg-primary text-on-primary hover:brightness-110"
                    : "border border-primary text-primary hover:bg-primary/5"
                }`}
              >
                {Boolean(tier.priceRaw) && hasUnfinishedPayment ? "Finishing your previous payment…" : tier.buttonText}
              </button>
            </div>
          ))}
        </div>

        <div className="mb-24">
          <h2 className="font-headline-md text-headline-md mb-8 text-center">Feature Breakdown</h2>
          <div className="overflow-x-auto border border-outline-variant rounded-xl bg-white shadow-sm">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr className="bg-surface-container-low border-b border-outline-variant">
                  <th className="p-4 font-label-caps text-label-caps">Features</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Free</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Pro</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Institutional</th>
                </tr>
              </thead>
              <tbody className="font-body-md divide-y divide-outline-variant">
                {features.map((f, i) => (
                  <tr key={i} className="hover:bg-surface-container-low/50 transition-colors">
                    <td className="p-4 font-medium">{f.name}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.free}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.pro}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.institutional}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white border border-outline-variant rounded-2xl overflow-hidden mb-24 flex flex-col md:flex-row shadow-sm">
          <div className="md:w-1/2 p-8 md:p-12 bg-surface-container-low flex flex-col justify-center">
            <h2 className="font-display-lg text-display-lg mb-6 leading-tight text-3xl md:text-4xl">
              Powered by Oracle AI Reasoning
            </h2>
            <p className="font-body-lg text-body-lg text-on-surface-variant mb-8 leading-relaxed">
              Our proprietary reasoning engine analyzes billions of on-chain data points to provide &quot;Oracle Insights&quot;—AI-generated predictive narratives that distinguish raw data from market noise.
            </p>
            <div className="flex flex-wrap gap-4">
              <div className="bg-white p-4 border border-outline-variant rounded-lg flex-1 min-w-[140px]">
                <span className="font-label-caps text-label-caps text-primary block mb-2">ACCURACY</span>
                <span className="font-headline-sm text-headline-sm">94.2%</span>
              </div>
              <div className="bg-white p-4 border border-outline-variant rounded-lg flex-1 min-w-[140px]">
                <span className="font-label-caps text-label-caps text-primary block mb-2">UPTIME</span>
                <span className="font-headline-sm text-headline-sm">99.99%</span>
              </div>
            </div>
          </div>
          <div className="md:w-1/2 relative h-64 md:h-auto overflow-hidden">
            <img
              className="absolute inset-0 w-full h-full object-cover grayscale opacity-80"
              alt="AI Reasoning Visualization"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuAa6_iBtnOn_m37HN9i8iSM2WGtLI2O7724tEV1Lwtbv-GGPQ23M_8Ng5x56bioNBpuHpLU5pnYBL3d8-em8tJDo4E1MGMdaCxefcsadvDMXYBr7fBmUYgX9aeZNQ_Hmx2d7KN57E8mUefZU9FDAW7Dprf7vIVrX3lK4CuZXz1njfkdn9pfaRe2ujTB9rsBD_BZUXUbRwNAkdVh9-cGODrXj8J5pggMpgxMrCUHFsylQTCEbzk7CM0sJVfddH4ugiek22UZ3yMKNA"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-surface-container-low via-transparent to-transparent md:block hidden"></div>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {selectedTier && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-on-background/40 backdrop-blur-sm"
              onClick={() => setSelectedTier(null)}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden z-10"
            >
              <div className="p-6 md:p-8 border-b border-outline-variant flex justify-between items-center">
                <h2 className="font-headline-md text-headline-md">Confirm Subscription</h2>
                <button
                  className="material-symbols-outlined text-on-surface-variant hover:text-error transition-colors cursor-pointer"
                  aria-label="Close"
                  onClick={() => setSelectedTier(null)}
                >
                  close
                </button>
              </div>
              <div className="p-6 md:p-8">
                <div className="bg-surface-container-low p-4 rounded-xl mb-8 flex justify-between items-center border border-outline-variant">
                  <div>
                    <p className="font-label-caps text-label-caps text-primary font-bold">
                      {selectedTier.name.toUpperCase()} TIER
                    </p>
                    <p className="font-body-md text-on-surface-variant">One payment, 24 hours of access</p>
                  </div>
                  <p className="font-headline-md text-headline-md text-on-surface text-2xl">
                    {selectedTier.priceStr}
                  </p>
                </div>

                <div className="space-y-6">
                  <h4 className="font-label-caps text-label-caps text-on-surface-variant border-b border-outline-variant pb-2">
                    PAYMENT METHOD
                  </h4>
                  <label 
                    className={`relative flex items-center p-4 border-2 rounded-xl cursor-pointer transition-all ${
                      paymentMethod === 'usdc' ? "border-primary bg-primary-container/5" : "border-outline-variant hover:bg-surface-container-low"
                    }`}
                    onClick={() => setPaymentMethod('usdc')}
                  >
                    <div className="w-10 h-10 bg-surface rounded-full flex items-center justify-center mr-4 border border-outline-variant overflow-hidden p-2">
                      <img
                        alt="USDC"
                        className="w-full h-full object-contain"
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuBBvpQJwosd2Frufdsjv33xmFEaqtUyhsE7FZ71B5HnGDdKxuZG6lxUBHLUN_72b5kg8Agl5q3-hEH2fEuAb-_pLcvFyXnM2K9saaM5DGU8S2lDvNZOLVEDFLm5SZ9m-oysbN474n7-m_f-fQPvR6m4aDDh2HeL4e_wKmfjwe5QkDRKk08h6N-QM6DBGHrMYIomFLujEFtdcTyccMq0i3ccnRBg7U4tC0Ig0D_KgAfB-bt_2ZdSeXk_I5gkzYAQszAvYnfg5lpgPA"
                      />
                    </div>
                    <div className="flex-grow">
                      <p className="font-body-md font-bold">Pay with USDC</p>
                      <p className="text-xs text-on-surface-variant">From your wallet on Stellar Testnet</p>
                    </div>
                    {paymentMethod === 'usdc' && (
                      <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                        check_circle
                      </span>
                    )}
                  </label>

                  <div className="rounded-xl border border-outline-variant bg-surface-container-low p-4">
                    <div className="flex justify-between items-center mb-4">
                      <span className="font-label-caps text-label-caps text-on-surface-variant">Status</span>
                      <span className="font-data-mono text-secondary text-sm">{statusMessage ?? "Ready"}</span>
                    </div>
                    {statusTxHash && (
                      <p ref={resultRef} tabIndex={-1} className="mb-3 text-xs text-on-surface-variant">
                        Receipt:{" "}
                        <TxLink hash={statusTxHash} />
                      </p>
                    )}
                    {isWrongNetwork && <p className="text-error text-sm">Wrong network; switch to Stellar Testnet.</p>}
                    {isUnfunded && <p className="text-warning text-sm">This account cannot cover the transaction fee.</p>}
                  </div>

                  <div className="flex flex-col gap-3">
                    {paymentComplete ? (
                      <button
                        onClick={() => setSelectedTier(null)}
                        className="w-full bg-primary text-primary-foreground py-3 rounded-lg font-label-caps text-label-caps hover:brightness-110"
                      >
                        Done
                      </button>
                    ) : (
                      <button
                        ref={payButtonRef}
                        onClick={() => void handlePayment()}
                        disabled={isSubmitting || !selectedTier.priceRaw || !address || isWrongNetwork}
                        className="w-full bg-primary text-primary-foreground py-3 rounded-lg font-label-caps text-label-caps hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isSubmitting ? "Processing…" : `Pay ${selectedTier.priceStr}`}
                      </button>
                    )}
                    {isMultisig && (
                      <button
                        onClick={() => void handlePrepareMultisigTransfer()}
                        className="w-full border border-outline-variant py-3 rounded-lg font-label-caps text-label-caps"
                      >
                        Prepare multisig transfer
                      </button>
                    )}
                    <button
                      onClick={() => setSelectedTier(null)}
                      className="w-full border border-outline-variant py-3 rounded-lg font-label-caps text-label-caps"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {reviewModel && (
        <TxReview
          model={reviewModel.model}
          changedFrom={reviewModel.changedFrom}
          onConfirm={() => closeReview(true)}
          onCancel={() => closeReview(false)}
        />
      )}
      <TxReviewPreferenceControl />
      {multisigSession && <MultisigReview session={multisigSession} onClose={() => setMultisigSession(null)} />}
      {statusMessage && <div className="sr-only">{statusMessage}</div>}
      {waitingForTransfer && <div className="sr-only">Waiting for transfer</div>}
      {renderTxPhase({ name: "building" })}
      {typeof xlmDeficit === "bigint" && <div className="sr-only">{xlmDeficit.toString()}</div>}
      {isInsufficientXlm && <div className="sr-only">Insufficient XLM</div>}
    </main>
  );
}
