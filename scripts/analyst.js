/**
 * analyst.js — Smart Strategy Engine for Helios Volume Bot
 * ═══════════════════════════════════════════════════════════
 * Each round, the analyst:
 *   1. Quotes both V2 and V3 routers for every candidate token
 *   2. Detects arbitrage opportunities (price diff between V2/V3)
 *   3. Scores each option (arb spread, price impact, recent activity)
 *   4. Returns the BEST decision: { action, engine, token, amount, reason }
 *
 * Decision logic:
 *   • If arb spread > THRESHOLD → SWAP (capture PnL)
 *   • If swap pool has high TVL / low impact → SWAP (good volume credit)
 *   • If we've done many swaps in a row → ADD LIQUIDITY (rebalance + LP fees)
 *   • Always biases toward whichever token has the best market depth
 * ═══════════════════════════════════════════════════════════
 */

import { ethers } from "ethers";

export class SmartAnalyst {
  constructor({
    v2Router,
    v3Quoter,
    weth,
    tokens,            // [{ symbol, address, decimals }]
    poolFee = 3000,
    arbThresholdBps = 50,    // 50 bps = 0.5% spread → trigger arb
    swapToLpRatio = 4,       // every 4 swaps, force one LP add
    minTokenBalance = 0n,    // min token balance to consider valid
  }) {
    this.v2Router        = v2Router;
    this.v3Quoter        = v3Quoter;
    this.weth            = weth;
    this.tokens          = tokens;
    this.poolFee         = Number(poolFee);
    this.arbThresholdBps = Number(arbThresholdBps);
    this.swapToLpRatio   = Number(swapToLpRatio);
    this.minTokenBalance = minTokenBalance;

    // Stats tracking
    this.stats = {
      totalSwaps:       0,
      totalLpAdds:      0,
      totalArbsTaken:   0,
      totalEthSpent:    0n,
      totalEthReceived: 0n,
      consecutiveSwaps: 0,
      perTokenStats:    {},   // sym → { swaps, volumeEth, lastQuote }
    };

    // Initialize per-token stats
    for (const t of tokens) {
      this.stats.perTokenStats[t.symbol] = {
        swaps:      0,
        lpAdds:     0,
        volumeEth:  0n,
        lastV2Out:  0n,
        lastV3Out:  0n,
        spreadBps:  0,
      };
    }
  }

  // ─── Quote both pools for a single token ─────────────────────
  async quoteBothPools(tokenInfo, amountWei) {
    const wethAddr = await this.weth.getAddress();

    // V2 quote
    let v2Out = 0n;
    try {
      const amounts = await this.v2Router.getAmountsOut(amountWei, [wethAddr, tokenInfo.address]);
      v2Out = amounts[1];
    } catch (_) { /* V2 pool may not exist */ }

    // V3 quote
    let v3Out = 0n;
    try {
      v3Out = await this.v3Quoter.quoteExactInputSingle.staticCall(
        wethAddr, tokenInfo.address, this.poolFee, amountWei, 0n
      );
    } catch (_) { /* V3 pool may not exist */ }

    // Spread in basis points (relative to better-quoted pool)
    let spreadBps = 0;
    if (v2Out > 0n && v3Out > 0n) {
      const diff = v2Out > v3Out ? v2Out - v3Out : v3Out - v2Out;
      const base = v2Out > v3Out ? v3Out : v2Out;
      spreadBps  = Number((diff * 10000n) / base);
    }

    return { v2Out, v3Out, spreadBps };
  }

  // ─── Score a token swap option ───────────────────────────────
  // Higher score = more attractive
  scoreSwap(quotes, tokenInfo) {
    let score = 0;

    // 1. Both pools have liquidity → +50 (more swap options)
    if (quotes.v2Out > 0n && quotes.v3Out > 0n) score += 50;
    else if (quotes.v2Out > 0n || quotes.v3Out > 0n) score += 20;
    else return -1000;   // no pool → can't swap

    // 2. Arb spread bonus (up to +100)
    score += Math.min(quotes.spreadBps, 100);

    // 3. Penalize tokens we've over-traded recently
    const recentSwaps = this.stats.perTokenStats[tokenInfo.symbol].swaps;
    score -= recentSwaps * 5;

    return score;
  }

  // ─── Score adding liquidity for a token ──────────────────────
  scoreLp(quotes, tokenInfo) {
    let score = 0;

    // Need V3 pool to add LP
    if (quotes.v3Out === 0n) return -1000;

    // Bonus for tokens with deep V3 liquidity (low spread = deep)
    if (quotes.spreadBps < 30) score += 40;

    // Penalize over-LP'd tokens
    const recentLps = this.stats.perTokenStats[tokenInfo.symbol].lpAdds;
    score -= recentLps * 15;

    // Bonus if we haven't LP'd this token yet
    if (recentLps === 0) score += 25;

    return score;
  }

  // ─── Main decision function ──────────────────────────────────
  // Returns: { action, engine, token, amount, reason, quotes }
  async decide({ minSwap, maxSwap, minLp, maxLp, mode = "auto" }) {
    // 1. Quote all tokens with the smaller swap amount (just for analysis)
    const probeAmount = ethers.parseEther("0.001");
    const candidates  = [];

    for (const tokenInfo of this.tokens) {
      const quotes = await this.quoteBothPools(tokenInfo, probeAmount);
      this.stats.perTokenStats[tokenInfo.symbol].lastV2Out = quotes.v2Out;
      this.stats.perTokenStats[tokenInfo.symbol].lastV3Out = quotes.v3Out;
      this.stats.perTokenStats[tokenInfo.symbol].spreadBps = quotes.spreadBps;

      candidates.push({
        token:    tokenInfo,
        quotes,
        swapScore: this.scoreSwap(quotes, tokenInfo),
        lpScore:   this.scoreLp(quotes, tokenInfo),
      });
    }

    // 2. Decide action: SWAP or LP
    let action;
    let reason;

    if (mode === "swap") {
      action = "swap";
      reason = "forced via mode=swap";
    } else if (mode === "liquidity") {
      action = "lp";
      reason = "forced via mode=liquidity";
    } else {
      // "auto" — analyst picks
      const bestCandidate = candidates.reduce((a, b) => a.swapScore > b.swapScore ? a : b);
      const arbDetected   = bestCandidate.quotes.spreadBps >= this.arbThresholdBps;

      if (arbDetected) {
        action = "swap";
        reason = `arb opportunity ${bestCandidate.quotes.spreadBps}bps on ${bestCandidate.token.symbol}`;
      } else if (this.stats.consecutiveSwaps >= this.swapToLpRatio) {
        action = "lp";
        reason = `${this.stats.consecutiveSwaps} consecutive swaps → rebalance with LP`;
      } else {
        action = "swap";
        reason = "no strong signal → standard volume swap";
      }
    }

    // 3. Pick best token for that action
    const sorted = action === "swap"
      ? candidates.sort((a, b) => b.swapScore - a.swapScore)
      : candidates.sort((a, b) => b.lpScore - a.lpScore);

    const best = sorted[0];

    // 4. Pick engine for swaps (V2 or V3, whichever quotes more output)
    let engine = null;
    if (action === "swap") {
      if (best.quotes.v2Out > 0n && best.quotes.v3Out > 0n) {
        engine = best.quotes.v2Out > best.quotes.v3Out ? "v2" : "v3";
      } else {
        engine = best.quotes.v2Out > 0n ? "v2" : "v3";
      }
    }

    // 5. Pick a random amount within bounds
    const [min, max] = action === "swap" ? [minSwap, maxSwap] : [minLp, maxLp];
    const amountEth  = (Math.random() * (Number(max) - Number(min)) + Number(min)).toFixed(6);
    const amountWei  = ethers.parseEther(amountEth);

    return {
      action,
      engine,
      token:   best.token,
      amount:  amountWei,
      amountEth,
      reason,
      quotes:  best.quotes,
      score:   action === "swap" ? best.swapScore : best.lpScore,
    };
  }

  // ─── Track outcome of an action (call after execution) ───────
  recordSwap({ token, amountIn, amountOut, engine }) {
    this.stats.totalSwaps++;
    this.stats.consecutiveSwaps++;
    this.stats.totalEthSpent    += amountIn;
    this.stats.totalEthReceived += amountOut ?? 0n;
    this.stats.perTokenStats[token.symbol].swaps++;
    this.stats.perTokenStats[token.symbol].volumeEth += amountIn;
  }

  recordLp({ token, amountWei }) {
    this.stats.totalLpAdds++;
    this.stats.consecutiveSwaps = 0;
    this.stats.perTokenStats[token.symbol].lpAdds++;
    this.stats.perTokenStats[token.symbol].volumeEth += amountWei;
  }

  recordArb() {
    this.stats.totalArbsTaken++;
  }

  // ─── Print summary report ────────────────────────────────────
  printReport() {
    const s = this.stats;
    const totalVol = ethers.formatEther(s.totalEthSpent);
    const pnlWei   = s.totalEthReceived - s.totalEthSpent;
    const pnlEth   = Number(ethers.formatEther(pnlWei < 0n ? -pnlWei : pnlWei));
    const pnlSign  = pnlWei < 0n ? "-" : "+";

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║              SMART ANALYST REPORT                    ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  Total swaps        : ${String(s.totalSwaps).padEnd(30)} ║`);
    console.log(`║  Total LP adds      : ${String(s.totalLpAdds).padEnd(30)} ║`);
    console.log(`║  Arbs taken         : ${String(s.totalArbsTaken).padEnd(30)} ║`);
    console.log(`║  Total volume       : ${(totalVol + " ETH").padEnd(30)} ║`);
    console.log(`║  Estimated PnL      : ${(pnlSign + pnlEth.toFixed(6) + " ETH").padEnd(30)} ║`);
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("║  Per-token breakdown:                                ║");
    for (const [sym, ps] of Object.entries(s.perTokenStats)) {
      const vol = ethers.formatEther(ps.volumeEth);
      console.log(`║    ${sym.padEnd(6)}  swaps=${String(ps.swaps).padEnd(3)} lps=${String(ps.lpAdds).padEnd(3)} vol=${vol.slice(0, 8).padEnd(10)} ║`);
    }
    console.log("╚══════════════════════════════════════════════════════╝\n");
  }
}
