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
//     is faster than the entry mean on purpose: the 120-bar mean is still
//     dragged down by the dip itself when the recovery starts, so exiting
//     against it would cut the trade short; the 60-bar mean follows the
//     recovery up and lets it run further.
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
// net PnL +$15.66 over 4 trades (2 round trips), max drawdown 0.76%.
// Honest caveat: the dev window holds only two round trips, so every
// parameter effect is one-trade granularity and this family is knife-edge by
// construction on any single window. What was checked before choosing these
// numbers: the same bot on the two previous btc-race dev windows (+$2.85 on
// the range-bound 20261117 window, -$44.67 on the steep -4.00% downtrend
// 20261115 window — a dip buyer loses when the market falls all day and never
// bounces), and the neighbourhood on this window (REF_N 105-150 all positive
// at +$7.14 to +$15.21; EXIT_N 45-90 and EXIT_BPS 80-100 all +$15.66;
// STOP 100-250 all +$15.66). Trend filters were tried and rejected: requiring
// the close above the 360-bar mean, or the 120-bar mean rising, blocks every
// trade on this window — the profitable legs ARE bounces inside a downtrend,
// so a filter that only buys uptrends buys nothing. Rejected variants:
// Bollinger/volatility-scaled entry, ladder scale-in, trailing exits, 2-bar
// confirmation, partial exits, rolling-high entry (all worse or zero trades
// on this window).

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- strategy constants (swept against the dev window; see header) ---
const REF_N = 120; // trailing mean of closes for entries, in bars (excludes the current bar)
const EXIT_N = 60; // trailing mean of closes for exits, in bars (excludes the current bar)
const DIP_BPS = 70; // entry: close this far below the trailing REF_N mean
const EXIT_BPS = 80; // exit: close this far above the trailing EXIT_N mean
const TAKE_BPS = 100; // exit: this far above the entry close (windfall lock)
const STOP_BPS = 150; // exit: this far below the entry close
const END_CUTOFF = 30; // no new entries in the final N bars of the window
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const SYMBOL = 'CBBTC';
const WINDOW_BARS = 1440;

/** Closes seen so far, oldest first; the current bar is appended after deciding. */
const closes: number[] = [];
/** The close the current position's entry was decided on, or null while flat. */
let entryClose: number | null = null;

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
      if (recovered || windfall || stopped) {
        // entryClose stays until the fill is confirmed by the next batch's
        // account: a rejected sell must be re-decided with the same entry.
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: the position is gone (a sell filled, or a buy was rejected), so
    // the entry close no longer applies.
    entryClose = null;

    // Flat: maybe enter, unless the window is nearly over.
    if (batch.seq >= WINDOW_BARS - END_CUTOFF) return [];
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
