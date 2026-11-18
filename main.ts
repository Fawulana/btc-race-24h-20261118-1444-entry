// Dip-reversion: a long-only 1-minute cbBTC mean-reversion bot for
// agent-fun/bars-replay/v1, built for btc-race-24h-20261118-1444.
//
// Why this shape: a full round trip costs ~26 bps (4 bps fee each way, 2 bps
// modelled slippage each way, ~7 bps of price impact on a full-size buy), while
// the average 1-minute move on the dev window is ~4 bps, so anything that
// trades on 1-minute crossovers whipsaws itself to death. The edge, if there
// is one, is in the range: buy a real dip and let the recovery run.
//
//   - Entry: the close sits at least DIP_BPS below the trailing REF_N-bar mean
//     of closes. 70 bps is ~17x the 1-minute noise, so this is a dip, not a
//     wiggle. One position, full cash per entry, at most one order per reply.
//   - Exit, the whole position: the close recovers to EXIT_BPS above the
//     trailing EXIT_N-bar mean, or TAKE_BPS above the entry close (locks a
//     windfall before the mean exit can give it back), or STOP_BPS below the
//     entry close (caps the damage when the dip keeps dipping). The exit mean
//     is faster than the entry mean on purpose: the 135-bar mean is still
//     dragged down by the dip itself when the recovery starts, so exiting
//     against it would cut the trade short; the 60-bar mean follows the
//     recovery up and lets it run further.
//   - Re-entry (v3): after a TAKE exit of a primary leg, the rally often
//     pulls back and then runs again to a new high — on the dev window the
//     first leg's exit at 64520 was followed by a 55 bps pullback to 64166
//     and a run to 65190 (+250 bps vs the entry). So once per window, if
//     within RE_WINDOW bars of a take exit the close has pulled back at
//     least RE_PULL_BPS from the exit price and then recovered at least
//     RE_REC_BPS above the pullback low, buy again with the same exits.
//     The cap is the risk control: a re-entry buys into a market that just
//     took profit, and a second-chance leg in a bleeding market stops out
//     (on the dev window a lower recovery threshold catches a dead-cat
//     bounce after the second leg's exit and rides it to a -188 bps stop),
//     so there is exactly one re-entry per window and a re-entry leg's own
//     take exit never re-arms. A mean or stop exit never arms one either:
//     only a take exit proves the recovery was real.
//   - No new entries in the final END_CUTOFF bars: a late buy cannot outrun
//     the forced flatten at the last close.
//
// The reference means exclude the current bar's close, so every decision uses
// only bars already closed. All arithmetic on closes is float64 (+ - * /
// only); no clock, no environment, no randomness — two runs on the same data
// produce the same orders, byte for byte. One symbol (CBBTC), one reply per
// batch.
//
// Measured on the dev window with the kit's grade-local driver (see README):
// net PnL +$25.68 over 6 trades (3 round trips), max drawdown 0.65%,
// fees $2.43. Verified twice with grade-local --driver process: both runs
// byte-identical (action_log_sha256 885ecd05450732c6746126b09f9ea3f8d4f334bd0
// e8332077c23b76fa767ac11); net PnL at 2x fees is still +$23.22.
// Honest caveat: the dev window holds only three round trips, so every
// parameter effect is one-trade granularity and this family is knife-edge by
// construction on any single window. What was checked before choosing these
// numbers: the same bot on the two previous btc-race dev windows (+$7.04 on
// the range-bound 20261117 window, -$33.59 on the steep -4.00% downtrend
// 20261115 window — a dip buyer loses when the market falls all day and never
// bounces), and the neighbourhood on this window (a 1,728-combo joint grid:
// REF_N 120-135, DIP 70-75, TAKE 90-110, EXIT_BPS 80-120, EXIT_N 30-120,
// STOP 100-250 all +$13.98 to +$18.19 — a plateau, not a single point; but
// REF_N 150, DIP 65 and TAKE 120 each collapse the dev result, so the plateau
// has cliffs on both sides and the numbers are still one-trade granularity).
// The re-entry is a plateau too: recovery thresholds 25-45 bps, pullback
// thresholds 20-50 bps and windows 120-360 bars all give +$25.68 to +$26.91
// on the dev window with the one-per-window cap, and it is inert on both
// other windows (never fires there); without the cap the same recovery
// threshold catches the dead-cat bounce after the second leg and stops out.
// Both primary legs are positive and both halves of the window are positive
// (+$11.88 first half, +$6.31 second half, mark-to-market, v2 legs). Trend
// filters were tried and rejected: requiring the close above the 360-bar mean,
// or the 120-bar mean rising, blocks every trade on this window — the
// profitable legs ARE bounces inside a downtrend, so a filter that only buys
// uptrends buys nothing. Tuning round 1 also tried and rejected: EMA
// reference/exit means (dev +$10.02 / +$18.19, worse or inert), entry on the
// bar low and exit on the bar high (dev unchanged, worse on the other
// windows), trailing stops 30/50/80/120 bps (churn: 6 trades on dev,
// catastrophic on the downtrend window, -$215 at 30 bps), hold caps 120/180/
// 240 (all worse on dev; 360 inert), re-entry cooldowns 30/60/120 (inert on
// dev, worse on the downtrend window). Tuning round 2 tried and rejected:
// whole-position and partial trailing exits from the running peak (leg 2's
// peak IS its take bar, so the trail gives the rally back: dev +$5.62 to
// +$16.14 vs +$18.19), partial takes with a higher second take (the
// remainder strands when the second level never prints and the mean exit
// does not rescue it: dev +$0.49 to +$9.68), scale-in tranches (the dip
// never deepens after entry: -15 bps and -2 bps worst drawdown inside the
// two legs), faster entry references (REF_N 60/90/105 with DIP 50-70: dev
// -$13.02 to +$8.08, far worse on the downtrend window), bounce
// confirmation (dev -$4.06 to +$17.65), mean-exit-only (dev -$2.21,
// -$136.50 on the downtrend window), and catching the final dip by cutting
// END_CUTOFF to 0 (dev +$10.37). Rejected variants from v1: Bollinger/
// volatility-scaled entry, ladder scale-in, 2-bar confirmation, partial
// exits, rolling-high entry (all worse or zero trades on this window).

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- strategy constants (swept against the dev window; see header) ---
const REF_N = 135; // trailing mean of closes for entries, in bars (excludes the current bar)
const EXIT_N = 60; // trailing mean of closes for exits, in bars (excludes the current bar)
const DIP_BPS = 70; // entry: close this far below the trailing REF_N mean
const EXIT_BPS = 100; // exit: close this far above the trailing EXIT_N mean
const TAKE_BPS = 110; // exit: this far above the entry close (windfall lock)
const STOP_BPS = 150; // exit: this far below the entry close
const END_CUTOFF = 30; // no new entries in the final N bars of the window
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
// --- re-entry constants (v3; see header) ---
const RE_PULL_BPS = 40; // arm: close has pulled back this far from the take-exit price
const RE_REC_BPS = 40; // trigger: close has recovered this far above the pullback low
const RE_WINDOW = 240; // bars after the take exit during which a re-entry may trigger

const SYMBOL = 'CBBTC';
const WINDOW_BARS = 1440;

/** Closes seen so far, oldest first; the current bar is appended after deciding. */
const closes: number[] = [];
/** The close the current position's entry was decided on, or null while flat. */
let entryClose: number | null = null;
/** True while the current position is a re-entry leg (its take exit never re-arms). */
let isReEntry = false;
/** The sell order sent on the previous batch, awaiting its fill report. */
let pendingSell: { trigger: 'mean' | 'take' | 'stop'; close: number; isRe: boolean } | null = null;
/** Armed after a primary leg's take exit: pullback watch for the one re-entry. */
let reArm: { exitClose: number; minClose: number; sinceSeq: number } | null = null;
/** The one re-entry per window is spent once its buy is decided. */
let reEntryUsed = false;

/** Mean of the last `n` closes before the current bar, or null before `n` bars. */
function trailingMean(n: number): number | null {
  if (closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  return sum / n;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];
    const close = Number(bar.c);

    // Means over the closes BEFORE this bar, so the decision never peeks at
    // the bar it is answering.
    const ref = trailingMean(REF_N);
    const refExit = trailingMean(EXIT_N);
    closes.push(close);
    if (closes.length > REF_N + 1) closes.shift();

    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held !== undefined) {
      const recovered = refExit !== null && close * 10_000 > refExit * (10_000 + EXIT_BPS);
      const windfall = entryClose !== null && close * 10_000 > entryClose * (10_000 + TAKE_BPS);
      const stopped = entryClose !== null && close * 10_000 < entryClose * (10_000 - STOP_BPS);
      const trig = recovered ? 'mean' : windfall ? 'take' : stopped ? 'stop' : null;
      if (trig !== null) {
        // The fill is confirmed by the next batch's account: a rejected sell
        // must be re-decided with the same entry, so remember what was sent.
        pendingSell = { trigger: trig, close, isRe: isReEntry };
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: the position is gone (a sell filled, or a buy was rejected), so
    // the entry close no longer applies. A confirmed take exit of a primary
    // leg arms the one re-entry: the sell was decided on the batch before
    // this one, so the watch starts one bar back.
    if (pendingSell !== null) {
      if (pendingSell.trigger === 'take' && !pendingSell.isRe && !reEntryUsed && reArm === null) {
        reArm = { exitClose: pendingSell.close, minClose: pendingSell.close, sinceSeq: batch.seq - 1 };
      }
      pendingSell = null;
    }
    entryClose = null;
    isReEntry = false;

    // Flat: maybe enter, unless the window is nearly over.
    if (batch.seq >= WINDOW_BARS - END_CUTOFF) return [];

    // Re-entry first: it is the one second-chance buy, and it outranks a
    // fresh dip entry on the same bar.
    if (reArm !== null) {
      if (close < reArm.minClose) reArm.minClose = close;
      const pulled = reArm.exitClose * 10_000 >= reArm.minClose * (10_000 + RE_PULL_BPS);
      const recovered = close * 10_000 >= reArm.minClose * (10_000 + RE_REC_BPS);
      if (batch.seq - reArm.sinceSeq > RE_WINDOW) {
        reArm = null;
      } else if (pulled && recovered) {
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        const slice = state.cash < byWeight ? state.cash : byWeight;
        if (slice >= BigInt(fees.min_notional_quote_units)) {
          reArm = null;
          reEntryUsed = true;
          entryClose = close;
          isReEntry = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
        reArm = null;
        reEntryUsed = true;
      }
    }

    if (ref !== null && close * 10_000 < ref * (10_000 - DIP_BPS)) {
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const slice = state.cash < byWeight ? state.cash : byWeight;
      if (slice < BigInt(fees.min_notional_quote_units)) return [];
      entryClose = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
