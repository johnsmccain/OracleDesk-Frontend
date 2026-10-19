import { describe, expect, it, vi } from "vitest";
import { xdr, type rpc } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { TxLifecycle, type TxPhase } from "../tx-lifecycle";

function makeFakeTx(opts: {
  hashHex?: string;
  maxTime?: number;
  simResult?: unknown;
  signError?: Error;
}) {
  const hash = Buffer.from(opts.hashHex ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  return {
    result: opts.simResult ?? 100n,
    simulation: {},
    sign: async () => {
      if (opts.signError) throw opts.signError;
    },
    signed: {
      hash: () => hash,
      timeBounds: opts.maxTime ? { maxTime: opts.maxTime } : undefined,
    },
  } as unknown as AssembledTransaction<bigint>;
}

describe("TxLifecycle", () => {
  it("emits phases in order for a successful buy and exposes hash from submitting onwards", async () => {
    const phases: TxPhase[] = [];
    const hashHex = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        ledger: 1234,
        returnValue: undefined,
      }),
    };

    const runner = new TxLifecycle<bigint>({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    runner.subscribe(() => {
      phases.push(runner.getSnapshot());
    });

    const tx = makeFakeTx({ hashHex });
    const result = await runner.run(tx, () => 500n);

    expect(result.value).toBe(500n);
    expect(result.txHash).toBe(hashHex);

    const phaseNames = phases.map((p) => p.name);
    expect(phaseNames).toEqual(["simulating", "awaiting-signature", "submitting", "pending", "confirmed"]);

    // Hash is present from submitting onwards
    const submitting = phases.find((p) => p.name === "submitting");
    expect((submitting as { hash: string }).hash).toBe(hashHex);

    const pending = phases.find((p) => p.name === "pending");
    expect((pending as { hash: string }).hash).toBe(hashHex);

    const confirmed = phases.find((p) => p.name === "confirmed");
    expect((confirmed as { hash: string }).hash).toBe(hashHex);
  });

  it("maps TRY_AGAIN_LATER to submission try-again-later", async () => {
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER" }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
    });

    const tx = makeFakeTx({});
    await expect(runner.run(tx, () => null)).rejects.toThrow();

    const snapshot = runner.getSnapshot();
    expect(snapshot.name).toBe("failed");
    if (snapshot.name === "failed") {
      expect(snapshot.error.kind).toBe("submission");
      expect(snapshot.error.submission).toBe("try-again-later");
    }
  });

  it("treats DUPLICATE as pending and polls the same hash", async () => {
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "DUPLICATE" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        ledger: 99,
        returnValue: undefined,
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    const tx = makeFakeTx({});
    const res = await runner.run(tx, () => 42n);
    expect(res.value).toBe(42n);
    expect(fakeServer.getTransaction).toHaveBeenCalled();
  });

  it("maps ERROR txBadSeq and txInsufficientFee result codes", async () => {
    const makeServer = (arm: () => xdr.TransactionResultResult) => ({
      sendTransaction: vi.fn().mockResolvedValue({
        status: "ERROR",
        errorResult: new xdr.TransactionResult({
          feeCharged: xdr.Int64.fromString("0"),
          result: arm(),
          ext: new xdr.TransactionResultExt(0),
        }),
      }),
    });

    const badSeqServer = makeServer(() => xdr.TransactionResultResult.txBadSeq());
    const runner1 = new TxLifecycle({
      server: badSeqServer as unknown as rpc.Server,
      contract: "marketCore",
    });
    await expect(runner1.run(makeFakeTx({}), () => null)).rejects.toThrow();
    expect(runner1.getSnapshot()).toMatchObject({
      name: "failed",
      error: { resultCode: "txBadSeq" },
    });

    const lowFeeServer = makeServer(() => xdr.TransactionResultResult.txInsufficientFee());
    const runner2 = new TxLifecycle({
      server: lowFeeServer as unknown as rpc.Server,
      contract: "marketCore",
    });
    await expect(runner2.run(makeFakeTx({}), () => null)).rejects.toThrow();
    expect(runner2.getSnapshot()).toMatchObject({
      name: "failed",
      error: { resultCode: "txInsufficientFee" },
    });
  });

  it("maps FAILED with Error(Contract, #12) to SlippageExceeded", async () => {
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "FAILED",
        resultXdr: "HostError: Error(Contract, #12)",
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    await expect(runner.run(makeFakeTx({}), () => null)).rejects.toThrow();
    const snapshot = runner.getSnapshot();
    expect(snapshot.name).toBe("failed");
    if (snapshot.name === "failed") {
      expect(snapshot.error.code).toBe("SlippageExceeded");
      expect(snapshot.error.submission).toBe("failed-on-chain");
    }
  });

  it("keeps polling through NOT_FOUND then confirms", async () => {
    let callCount = 0;
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return { status: "NOT_FOUND", latestLedger: 10, latestLedgerCloseTime: 1000 };
        }
        return { status: "SUCCESS", ledger: 11, returnValue: undefined };
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    const res = await runner.run(makeFakeTx({}), () => 77n);
    expect(res.value).toBe(77n);
    expect(callCount).toBe(3);
  });

  it("emits expired using latestLedgerCloseTime, not Date.now", async () => {
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "NOT_FOUND",
        latestLedger: 50,
        latestLedgerCloseTime: 2000, // beyond maxTime 1500
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    const tx = makeFakeTx({ maxTime: 1500 });
    await expect(runner.run(tx, () => null)).rejects.toThrow();

    const snapshot = runner.getSnapshot();
    expect(snapshot.name).toBe("expired");
    if (snapshot.name === "expired") {
      expect(snapshot.lastLedgerSeen).toBe(50);
    }
  });

  it("wallet rejection yields failed with kind rejected and null hash", async () => {
    const fakeServer = {
      sendTransaction: vi.fn(),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
    });

    const tx = makeFakeTx({
      signError: new Error("User declined transaction"),
    });

    await expect(runner.run(tx, () => null)).rejects.toThrow();
    const snapshot = runner.getSnapshot();
    expect(snapshot.name).toBe("failed");
    if (snapshot.name === "failed") {
      expect(snapshot.hash).toBeNull();
      expect(snapshot.error.kind).toBe("rejected");
    }
  });

  it("unsubscribe stops notifications but run() still resolves", async () => {
    const notifications: TxPhase[] = [];
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        ledger: 10,
        returnValue: undefined,
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    const unsub = runner.subscribe(() => {
      notifications.push(runner.getSnapshot());
    });

    // Unsubscribe immediately
    unsub();

    const res = await runner.run(makeFakeTx({}), () => 123n);
    expect(res.value).toBe(123n);
    // notifications array received 0 updates after unsubscription
    expect(notifications.length).toBe(0);
    expect(runner.getSnapshot().name).toBe("confirmed");
  });

  it("reports every phase to the onPhase callback, in order", async () => {
    const phases: TxPhase[] = [];
    const fakeServer = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        ledger: 5,
        returnValue: undefined,
      }),
    };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
      pollIntervalMs: 1,
    });

    await runner.run(makeFakeTx({}), () => 1n, undefined, (phase) => phases.push(phase));

    // The wallet prompt, the submission and the confirmation, in that order.
    expect(phases.map((p) => p.name)).toEqual([
      "simulating",
      "awaiting-signature",
      "submitting",
      "pending",
      "confirmed",
    ]);
  });

  it("never reports a submission when the wallet rejects", async () => {
    const phases: TxPhase[] = [];
    const fakeServer = { sendTransaction: vi.fn() };

    const runner = new TxLifecycle({
      server: fakeServer as unknown as rpc.Server,
      contract: "marketCore",
    });

    await expect(
      runner.run(makeFakeTx({ signError: new Error("User declined transaction") }), () => null, undefined, (phase) =>
        phases.push(phase),
      ),
    ).rejects.toThrow();

    expect(phases.map((p) => p.name)).toEqual(["simulating", "awaiting-signature", "failed"]);
    expect(fakeServer.sendTransaction).not.toHaveBeenCalled();
  });
});
