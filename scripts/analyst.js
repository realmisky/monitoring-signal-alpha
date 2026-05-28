/**
 * analyst.js — Smart Strategy Engine v2 (volume + risk aware)
 * ═══════════════════════════════════════════════════════════
 *  Each round:
 *   1. Pulls live market snapshot (TVL, V3 liquidity, subgraph volume)
 *   2. Quotes V2 + V3 to detect arbitrage spreads
 *   3. Estimates price impact for proposed trade size
 *   4. Volume-weighted sizing  → caps trade at MAX_PRICE_IMPACT_BPS
 *   5. Decides action: arb-swap | volume-swap | LP add
 *   6. Picks engine (V2 or V3) by best quote
 * ═══════════════════════════════════════════════════════════
 */

import { ethers } from "ethers";

export class SmartAnalyst {
  constructor({
    v2Router,
    v3Quoter,
    weth,
    market,                       // MarketData instance
    tokens,
    poolFee             = 3000,
    arbThresholdBps     = 50,
    swapToLpRatio       = 4,
    maxPriceImpactBps   = 100,    // cap impact at 1%
  }) {
    this.v2Router          = v2Router;
    this.v3Quoter          = v3Quoter;
    this.weth              = weth;
    this.market            = market;
    this.tokens            = tokens;
    this.poolFee           = Number(poolFee);
    this.arbThresholdBps   = Number(arbThresholdBps);
    this.swapToLpRatio     = Number(swapToLpRatio);
    this.maxPriceImpactBps = Number(maxPriceImpactBps);

    this.consecutiveSwaps = 0;
    this.perToken         = {};
    for (const t of tokens) {
      this.perToken[t.symbol] = { swaps: 0, lpAdds: 0, lastSpread: 0 };
    }
  }

  // ─── Quote both routers at given size ──────────────────────
  async quoteBothPools(tokenInfo, amountWei) {
    const wethAddr = await this.weth.getAddress();

    let v2Out = 0n;
    try {
      const a = await this.v2Router.getAmountsOut(amountWei, [wethAddr, tokenInfo.address]);
      v2Out = a[1];
    } catch (_) {}

    let v3Out = 0n;
    try {
      v3Out = await this.v3Quoter.quoteExactInputSingle.staticCall(
        wethAddr, tokenInfo.address, this.poolFee, amountWei, 0n
      );
    } catch (_) {}

    let spreadBps = 0;
    if (v2Out > 0n && v3Out > 0n) {
      const diff = v2Out > v3Out ? v2Out - v3Out : v3Out - v2Out;
      const base = v2Out > v3Out ? v3Out : v2Out;
      spreadBps  = Number((diff * 10000n) / base);
    }
    return { v2Out, v3Out, spreadBps };
  }

  // ─── Volume-weighted sizing ────────────────────────────────
  // Reduce trade size if estimated price impact exceeds cap
  async sizeWithImpactCap(tokenInfo, amountIn) {
    const wethAddr = await this.weth.getAddress();
    let size       = amountIn;
    let impact     = await this.market.estimatePriceImpact(wethAddr, tokenInfo.address, this.poolFee, size);

    let attempts = 0;
    while (impact !== null && impact > this.maxPriceImpactBps && attempts < 4) {
      size   = size / 2n;     // halve until impact is acceptable
      impact = await this.market.estimatePriceImpact(wethAddr, tokenInfo.address, this.poolFee, size);
      attempts++;
    }
    return { size, impactBps: impact };
  }

  // ─── Score swap option ─────────────────────────────────────
  scoreSwap(snap, quotes, tokenInfo) {
    let score = 0;
    if (quotes.v2Out > 0n && quotes.v3Out > 0n) score += 50;
    else if (quotes.v2Out > 0n || quotes.v3Out > 0n) score += 20;
    else return -1000;

    score += Math.min(quotes.spreadBps, 100);

    // Bonus for deep liquidity
    if (snap.v3Liquidity > 0n) {
      const depthLog = Math.log10(Number(snap.v3Liquidity / 10n ** 18n) + 1);
      score += Math.min(depthLog * 10, 30);
    }

    // Bonus for active pools (subgraph volume)
    if (snap.subgraphVol > 1000) score += 20;
    else if (snap.subgraphVol > 100) score += 10;

    score -= this.perToken[tokenInfo.symbol].swaps * 5;
    return Math.round(score);
  }

  scoreLp(snap, quotes, tokenInfo) {
    let score = 0;
    if (!snap.v3HasPool) return -1000;
    if (quotes.spreadBps < 30) score += 40;
    if (snap.v3Liquidity > 0n) {
      const depthLog = Math.log10(Number(snap.v3Liquidity / 10n ** 18n) + 1);
      score += Math.min(depthLog * 10, 30);
    }
    score -= this.perToken[tokenInfo.symbol].lpAdds * 15;
    if (this.perToken[tokenInfo.symbol].lpAdds === 0) score += 25;
    return Math.round(score);
  }

  // ─── Main decision ─────────────────────────────────────────
  async decide({ minSwap, maxSwap, minLp, maxLp, mode = "auto" }) {
    const probeAmount = ethers.parseEther("0.001");
    const candidates  = [];

    for (const tokenInfo of this.tokens) {
      const [snap, quotes] = await Promise.all([
        this.market.snapshotToken(tokenInfo, this.poolFee),
        this.quoteBothPools(tokenInfo, probeAmount),
      ]);
      this.perToken[tokenInfo.symbol].lastSpread = quotes.spreadBps;
      candidates.push({
        token:     tokenInfo,
        snap,
        quotes,
        swapScore: this.scoreSwap(snap, quotes, tokenInfo),
        lpScore:   this.scoreLp(snap, quotes, tokenInfo),
      });
    }

    let action, reason;
    if (mode === "swap") {
      action = "swap"; reason = "forced via mode=swap";
    } else if (mode === "liquidity") {
      action = "lp"; reason = "forced via mode=liquidity";
    } else {
      const bestSwap = candidates.reduce((a, b) => a.swapScore > b.swapScore ? a : b);
      const arb      = bestSwap.quotes.spreadBps >= this.arbThresholdBps;
      if (arb) {
        action = "swap";
        reason = `arb spread ${bestSwap.quotes.spreadBps}bps on ${bestSwap.token.symbol}`;
      } else if (this.consecutiveSwaps >= this.swapToLpRatio) {
        action = "lp";
        reason = `${this.consecutiveSwaps} consecutive swaps → rebalance with LP`;
      } else {
        action = "swap";
        reason = "no arb signal → standard volume swap";
      }
    }

    const sorted = action === "swap"
      ? candidates.sort((a, b) => b.swapScore - a.swapScore)
      : candidates.sort((a, b) => b.lpScore   - a.lpScore);
    const best = sorted[0];

    let engine = null;
    if (action === "swap") {
      if (best.quotes.v2Out > 0n && best.quotes.v3Out > 0n) {
        engine = best.quotes.v2Out > best.quotes.v3Out ? "v2" : "v3";
      } else {
        engine = best.quotes.v2Out > 0n ? "v2" : "v3";
      }
    }

    // Pick random amount in range
    const [min, max] = action === "swap" ? [minSwap, maxSwap] : [minLp, maxLp];
    const amountEth  = (Math.random() * (Number(max) - Number(min)) + Number(min)).toFixed(6);
    let amountWei    = ethers.parseEther(amountEth);

    // Volume-weighted sizing for swaps (V3 only — needs quoter)
    let priceImpactBps = null;
    if (action === "swap" && engine === "v3") {
      const sized = await this.sizeWithImpactCap(best.token, amountWei);
      amountWei      = sized.size;
      priceImpactBps = sized.impactBps;
    }

    return {
      action,
      engine,
      token:          best.token,
      amount:         amountWei,
      amountEth:      ethers.formatEther(amountWei),
      reason,
      quotes:         best.quotes,
      snap:           best.snap,
      priceImpactBps,
      score:          action === "swap" ? best.swapScore : best.lpScore,
    };
  }

  recordSwap(symbol) {
    this.consecutiveSwaps++;
    this.perToken[symbol].swaps++;
  }

  recordLp(symbol) {
    this.consecutiveSwaps = 0;
    this.perToken[symbol].lpAdds++;
  }
}
