import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { useEffect } from "react";

/**
 * The buy ticket owns the amount input, the quote and the trade. Typing in
 * the amount field must re-render the ticket and nothing else in the modal.
 *
 * The chain reads are stubbed: this test is about render isolation, not about
 * the contract calls, which have their own tests.
 */

vi.mock("@/lib/hooks/useStellar", () => ({
  useAccountAuth: () => ({ data: undefined, isLoading: false }),
  useAccountReserve: () => ({
    data: {
      funded: true,
      balance: 0n,
      minBalance: 0n,
      sellingLiabilities: 0n,
      spendable: 0n,
      subentries: 0,
      sponsoring: 0,
      sponsored: 0,
    },
    isLoading: false,
    isError: false,
  }),
  useBuy: () => ({ mutateAsync: async () => ({}), isPending: false, phase: { name: "building" } }),
  useEnableUsdc: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useExactBuyQuote: () => ({ data: undefined, error: null, isFetching: false }),
  useLedgerNow: () => ({ data: undefined }),
  useMarketConfig: () => ({ data: undefined }),
  useOnChainMarket: () => ({ data: undefined, dataUpdatedAt: 0, refetch: async () => {} }),
  usePosition: () => ({ data: undefined }),
  usePositionState: () => ({ data: undefined }),
  usePrepareBuy: () => ({ data: undefined, isLoading: false }),
  usePrepareMultisig: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useQuoteBuy: () => ({ data: undefined, error: null, isFetching: false }),
  useUsdcBalance: () => ({ data: undefined }),
  useUsdcBalanceState: () => ({ data: undefined }),
  useUsdcTrustline: () => ({ data: { kind: "missing" } }),
  useImportMultisig: () => ({ mutateAsync: async () => ({}) }),
  useSubmitMultisig: () => ({ mutateAsync: async () => ({}) }),
}));

vi.mock("@/lib/health/HealthProvider", () => ({
  useHealth: () => ({
    socket: "connected",
    rpc: { status: "ok", latestLedger: 1, ledgerAgeSec: 0, checkedAt: 1 },
    backend: { status: "ok", checkedAt: 1 },
    overall: "live",
    retry: () => {},
  }),
}));

vi.mock("@/lib/settings/useSettings", () => ({
  useSettings: () => ({
    settings: { slippageBps: 100, notifications: { execution: true, news: true, shifts: true } },
    setSlippageBps: () => {},
    setNotifications: () => {},
  }),
}));

vi.mock("@/lib/stellar/ledger-clock", () => ({
  useLedgerNow: () => ({ now: 1_000 }),
  getLedgerNow: () => 1_000,
}));

const signInWithWallet = vi.fn(async (address: string) => ({ walletAddress: address }));

vi.mock("@/lib/api/auth", () => ({
  getStoredSessionWallet: () => null,
  clearAuthSession: () => {},
  signInWithWallet: (address: string) => signInWithWallet(address),
}));

vi.mock("@/lib/api/cross-tab-sync", () => ({
  createCrossTabSync: () => ({ unsubscribe: () => {} }),
  broadcastWalletDisconnect: () => {},
}));

vi.mock("@/lib/notifications/push", () => ({
  storedPushWallet: () => null,
  unsubscribe: async () => {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const { createFakeKit, WalletHarness, CommitCounter, FAKE_ADDRESS } = await import("./wallet-harness");
const { AnnouncerProvider } = await import("@/components/ui/announcer");
const { BuyTicket } = await import("@/components/market/buy-ticket");
const { useWalletActions, useWalletSession } = await import("@/lib/contexts/WalletContext");

function Header() {
  return <h1>Market question</h1>;
}

function SessionProbe({ onChange }: { onChange: (value: ReturnType<typeof useWalletSession>) => void }) {
  const value = useWalletSession();
  useEffect(() => {
    onChange(value);
  }, [value, onChange]);
  return null;
}

function ActionsProbe({ onChange }: { onChange: (value: ReturnType<typeof useWalletActions>) => void }) {
  const value = useWalletActions();
  useEffect(() => {
    onChange(value);
  }, [value, onChange]);
  return null;
}

beforeEach(() => {
  signInWithWallet.mockClear();
});

describe("quick-view render isolation", () => {
  it("re-renders only the buy ticket when the amount changes", async () => {
    const kit = createFakeKit({ address: FAKE_ADDRESS });
    let headerCommits = 0;
    let ticketCommits = 0;
    let sessionCommits = 0;
    const onHeader = () => {
      headerCommits += 1;
    };
    const onTicket = () => {
      ticketCommits += 1;
    };
    const onSession = () => {
      sessionCommits += 1;
    };
    const onSessionValue = () => {};

    render(
      <AnnouncerProvider>
        <WalletHarness kit={kit}>
          <CommitCounter id="header" onCommit={onHeader}>
            <Header />
          </CommitCounter>
          <CommitCounter id="ticket" onCommit={onTicket}>
            <BuyTicket onChainMarketId="1" side="Yes" />
          </CommitCounter>
          <CommitCounter id="session" onCommit={onSession}>
            <SessionProbe onChange={onSessionValue} />
          </CommitCounter>
          <ActionsProbe onChange={onSessionValue} />
        </WalletHarness>
      </AnnouncerProvider>,
    );

    const input = screen.getByRole("textbox", { name: /Amount \(USDC\)/i }) as HTMLInputElement;
    await waitFor(() => expect(ticketCommits).toBeGreaterThan(0));

    const headerBefore = headerCommits;
    const ticketBefore = ticketCommits;
    const sessionBefore = sessionCommits;

    // Ten keystrokes.
    for (let i = 0; i < 10; i++) {
      fireEvent.change(input, { target: { value: input.value + String(i) } });
    }

    expect(ticketCommits).toBeGreaterThan(ticketBefore);
    expect(headerCommits).toBe(headerBefore);
    expect(sessionCommits).toBe(sessionBefore);
  });

  it("does not re-render the buy ticket when only the session changes", async () => {
    const kit = createFakeKit({ address: FAKE_ADDRESS });
    let ticketCommits = 0;
    let sessionCommits = 0;
    let session: ReturnType<typeof useWalletSession> | null = null;
    let actions: ReturnType<typeof useWalletActions> | null = null;
    const onTicket = () => {
      ticketCommits += 1;
    };
    const onSession = () => {
      sessionCommits += 1;
    };
    const onSessionValue = (value: ReturnType<typeof useWalletSession>) => {
      session = value;
    };
    const onActionsValue = (value: ReturnType<typeof useWalletActions>) => {
      actions = value;
    };

    render(
      <AnnouncerProvider>
        <WalletHarness kit={kit}>
          <CommitCounter id="ticket" onCommit={onTicket}>
            <BuyTicket onChainMarketId="1" side="Yes" />
          </CommitCounter>
          <CommitCounter id="session" onCommit={onSession}>
            <SessionProbe onChange={onSessionValue} />
          </CommitCounter>
          <ActionsProbe onChange={onActionsValue} />
        </WalletHarness>
      </AnnouncerProvider>,
    );

    await waitFor(() => expect(ticketCommits).toBeGreaterThan(0));
    const ticketBefore = ticketCommits;
    const sessionBefore = sessionCommits;

    // Signing in changes the session slice and nothing else.
    await act(async () => {
      await actions?.ensureSession();
    });

    await waitFor(() => expect(session?.isAuthenticated).toBe(true));
    expect(sessionCommits).toBeGreaterThan(sessionBefore);
    expect(ticketCommits).toBe(ticketBefore);
  });
});
