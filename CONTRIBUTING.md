# Contributing to the OracleDesk frontend

Thanks for helping. This is a testnet-only, unaudited project; see
[docs/STATUS.md](docs/STATUS.md) for what works today.

## Setup

```bash
git clone --recurse-submodules https://github.com/OracleDesk/OracleDesk-Frontend.git
cd OracleDesk-Frontend
nvm use            # Node 22 (see .nvmrc)
npm ci
cp .env.example .env.local
npm run dev
```

Forgot `--recurse-submodules`? Run `git submodule update --init`.

## Branches and commits

- Branch names: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. One logical change per
  commit.
- No force-pushes to shared branches.

## Checks (CI runs exactly these)

```bash
npm run check:bindings   # generated contract code matches the submodule
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run e2e:testnet` is an optional, read-only check against a running
backend and live testnet; see the header of `e2e/testnet.e2e.test.ts`.

## Measuring realtime feeds

Use separate terminals:

```bash
node scripts/realtime-burst.mjs --manual --port 4310
NEXT_PUBLIC_API_URL=http://localhost:4310/api/v1 npm run dev
```

Open `/markets?profile=1` or `/?profile=1` and keep that tab visible.
Development-only React Profiler logs `[realtime-profile]`, the component
name, commit count and total `actualDuration` every second. Let the page
settle, then trigger each sample from another terminal:

```bash
curl 'http://localhost:4310/burst?count=500&rate=500'
# Wait for completion before starting the next sample.
curl 'http://localhost:4310/burst?count=500&rate=50'
```

Sum logged intervals covering each burst and its final settling interval.
Use the same browser, viewport and animation preference for both revisions.
For a baseline, instrument the original feed with the same profiler wrapper;
the original feeds need no functional changes. Profiler time measures React
render work, not socket validation, paint, or end-to-end latency. Slow
baselines may coalesce events under load, so fewer commits alone do not
prove better responsiveness. Production ignores `?profile=1`.

The simulator serves an empty market API and emits synthetic public trades;
it never signs or submits transactions. `--count`, `--rate` and `--port` also
configure its automatic burst (omit `--manual` to emit after the first
connection). See [docs/STATUS.md](docs/STATUS.md) for measured results.

## When the contracts change

The contracts live in
[OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract)
and are the source of truth. This repo pins them as the `contracts`
submodule and copies the generated code into `lib/stellar/generated/`.

```bash
git -C contracts fetch origin
git -C contracts checkout <new commit>
npm run sync:bindings
npm run typecheck && npm test   # the Category exhaustiveness check fails here if the enum changed
git add contracts lib/stellar/generated
```

Never edit `lib/stellar/generated/` by hand. If you think a contract needs
to change, write it up in [docs/contract-requests.md](docs/contract-requests.md)
and open the issue in the contracts repo.

## Working on a Drips Wave issue

This repo takes part in [Drips Wave](https://docs.drips.network/wave/).
Per the current Drips docs:

1. Find the issue on the Drips Wave **Explore** page (or in this repo's
   issues once a maintainer has added it to a Wave).
2. **Apply** for it on Drips. Don't start coding until a maintainer assigns
   you; the issue isn't yours before that.
3. Open a PR that links the issue (`Closes #123`).
4. Points are earned when the PR is merged and the issue is marked resolved
   **before the Wave ends**. Complexity (Trivial 100 / Medium 150 /
   High 200 points) is set by the maintainer; if an issue turns out harder
   than labelled, say so on the issue before it's resolved.

Drips also limits how many issues one person can be assigned per
organization in a Wave; check the Drips docs for the current numbers.
Issue drafts live in [docs/wave-issues/](docs/wave-issues/) before they're
filed.

## Status announcements

Every flow that moves money or signs something must tell a screen reader
what is happening. The app has one announcer, mounted in `app/layout.tsx`:

```tsx
import { useAnnounce, useFocusReturn } from "@/components/ui/announcer";
import { txMessages } from "@/lib/a11y/tx-messages";

const announce = useAnnounce();
const focusReturn = useFocusReturn();

announce(txMessages.awaitingSignature("Buy YES shares"), {
  dedupeKey: `buy:${marketId}:awaiting`,
});
```

The rules:

- **Announce, don't replace.** A visible status line that is swapped out
  mid-sentence is not announced. Put the message in the live region through
  `useAnnounce()`; keep the visible text for sighted users.
- **Use the vocabulary in `lib/a11y/tx-messages.ts`.** The messages are
  written for someone who cannot see the screen. Do not invent new copy per
  page.
- **Never announce a URL or a hash.** A screen reader would read out
  "h t t p s colon slash slash" and 64 hex characters. Put the transaction in
  a `<TxLink hash={...} />` (`components/ui/tx-link.tsx`), which is labelled
  and says that it opens a new tab.
- **Give the focus back.** A wallet extension opens its own window and drops
  the focus when it closes. Call `focusReturn.capture()` before the wallet
  opens (the `onPhase` callback of the write hook does this for you) and
  `focusReturn.restore()` when the transaction settles.
- **Do not close a message before it was read.** The premium checkout used to
  close itself four seconds after a successful payment, which cut the
  announcement off. Use an explicit "Done" button instead.
- **Do not open a new tab on the user's behalf.** The copy-trade flow used to
  call `window.open` after a successful trade, which moved the focus without
  warning.

The write hooks accept an `onPhase` callback that reports every phase of the
transaction, so a flow can announce "waiting for your wallet", "sent to the
network" and "confirmed" without touching the hooks themselves:

```tsx
await buy.mutateAsync({ marketId, outcome, collateralIn, slippageBps, onPhase });
```

## What a good PR includes

- A short description and the issue it closes.
- All checks above passing locally.
- Screenshots or a short recording for any UI change.
- Tests for new logic (`lib/**` especially), and updated docs
  (`docs/api.md` is owned by the backend; change it there first).
- UI copy in plain sentence case, from the user's point of view. Don't
  claim anything the app doesn't do; label sample data as demo data.
- Amounts as `bigint` in 7-decimal USDC base units
  (`lib/stellar/units.ts`), never floats, for anything that reaches a
  transaction.

## Never commit secrets

No `.env*` files (only `.env.example`), no Stellar secret seeds (`S…`), no
API keys. Every `NEXT_PUBLIC_*` variable ends up in browser JavaScript, so a
secret must never go in one. If you commit a secret by accident, tell a
maintainer privately (see [SECURITY.md](SECURITY.md)) so it can be rotated;
removing it in a later commit is not enough.
