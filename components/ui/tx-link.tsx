import type { ReactNode } from "react";
import { explorerTx } from "@/lib/stellar/config";

export interface TxLinkProps {
  /** The transaction hash. */
  hash: string;
  /** The visible label. Defaults to "View transaction". */
  children?: ReactNode;
  className?: string;
}

/**
 * A link to a transaction on Stellar Expert.
 *
 * The hash is never part of the visible text: a screen reader would read out
 * 64 hex characters. The link says what it does and that it opens a new tab.
 */
export function TxLink({ hash, children, className }: TxLinkProps) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "text-primary hover:underline font-data-mono"}
    >
      {children ?? "View transaction"}
      <span className="sr-only"> on Stellar Expert (opens in a new tab)</span>
    </a>
  );
}
