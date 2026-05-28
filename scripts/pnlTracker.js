/**
 * pnlTracker.js — Real PnL accounting with gas + trade log
 * ═══════════════════════════════════════════════════════════
 *  Tracks every trade with full breakdown:
 *    • ETH balance before/after (ground truth)
 *    • Gas used × gas price = real gas cost
 *    • Slippage (expected vs actual output)
 *    • Cumulative PnL (in ETH)
 *
 *  Writes a per-session JSON log to ./trade-log.json
 * ═══════════════════════════════════════════════════════════
 */

import { ethers } from "ethers";
import fs from "fs";

export class PnLTracker {
  constructor({ provider, walletAddress, logPath = "./trade-log.json" }) {
    this.provider      = provider;
    this.walletAddress = walletAddress;
    this.logPath       = logPath;

    this.startBalance   = 0n;
    this.currentBalance = 0n;

    this.trades = [];
    this.totals = {
      ethSpent:    0n,
      ethReceived: 0n,
      gasSpent:    0n,
      realizedPnL: 0n,
      arbsTaken:   0,
      lpAdds:      0,
      swaps:       0,
      failed:      0,
    };

    this.startTime = Date.now();
  }

  async init() {
    this.startBalance   = await this.provider.getBalance(this.walletAddress);
    this.currentBalance = this.startBalance;
    this.log(`📊 PnL tracker started. Start balance: ${ethers.formatEther(this.startBalance)} ETH`);
  }

  log(msg) {
    console.log(`[${new Date().toISOString()}]  ${msg}`);
  }

  // Wraps a tx send so we capture gas used + balance delta
  async sendAndTrack(label, sendFn) {
    const balBefore = await this.provider.getBalance(this.walletAddress);
    let tx, receipt, error;
    try {
      tx      = await sendFn();
      receipt = await tx.wait();
    } catch (e) {
      error = e;
    }
    const balAfter = await this.provider.getBalance(this.walletAddress);
    const gasCost  = receipt ? receipt.gasUsed * receipt.gasPrice : 0n;

    if (error) {
      this.totals.failed++;
      this.log(`   ❌ ${label} failed: ${error.shortMessage ?? error.message}`);
      return { ok: false, error };
    }

    return {
      ok:       true,
      tx,
      receipt,
      gasCost,
      balBefore,
      balAfter,
      ethDelta: balAfter - balBefore,
    };
  }

  recordSwapLeg({ direction, engine, tokenSymbol, amountIn, amountOut, expectedOut, gasCost, txHash, priceImpactBps }) {
    const trade = {
      timestamp:      new Date().toISOString(),
      type:           "swap",
      direction,
      engine,
      token:          tokenSymbol,
      amountInWei:    amountIn?.toString()    ?? null,
      amountOutWei:   amountOut?.toString()   ?? null,
      expectedOutWei: expectedOut?.toString() ?? null,
      slippageBps:    null,
      gasCostWei:     gasCost?.toString()     ?? "0",
      gasCostEth:     gasCost ? Number(ethers.formatEther(gasCost)) : 0,
      priceImpactBps: priceImpactBps ?? null,
      txHash,
    };
    if (expectedOut && amountOut && expectedOut > 0n) {
      const slip = expectedOut > amountOut ? expectedOut - amountOut : 0n;
      trade.slippageBps = Number((slip * 10000n) / expectedOut);
    }
    this.trades.push(trade);
    this.totals.gasSpent += gasCost ?? 0n;
    this.totals.swaps++;
    this.log(`   📝 ${direction.toUpperCase()} ${engine} ${tokenSymbol} | gas=${trade.gasCostEth.toFixed(8)} ETH | impact=${priceImpactBps ?? "?"}bps | slip=${trade.slippageBps ?? "?"}bps`);
  }

  recordRoundTrip({ tokenSymbol, ethIn, ethOut, totalGas }) {
    const realizedWei = ethOut - ethIn - totalGas;
    this.totals.realizedPnL += realizedWei;
    this.totals.ethSpent    += ethIn;
    this.totals.ethReceived += ethOut;
    const sign  = realizedWei >= 0n ? "+" : "-";
    const value = ethers.formatEther(realizedWei < 0n ? -realizedWei : realizedWei);
    this.log(`   💰 Round-trip ${tokenSymbol} | net PnL: ${sign}${value} ETH (gas-adjusted)`);
    return realizedWei;
  }

  recordLP({ tokenSymbol, ethDeposited, gasCost, txHash, tokenId }) {
    const trade = {
      timestamp:       new Date().toISOString(),
      type:            "liquidity",
      token:           tokenSymbol,
      ethDepositedWei: ethDeposited?.toString() ?? null,
      gasCostWei:      gasCost?.toString()      ?? "0",
      gasCostEth:      gasCost ? Number(ethers.formatEther(gasCost)) : 0,
      tokenId:         tokenId?.toString() ?? null,
      txHash,
    };
    this.trades.push(trade);
    this.totals.gasSpent += gasCost ?? 0n;
    this.totals.lpAdds++;
    this.log(`   📝 LP add ${tokenSymbol} | gas=${trade.gasCostEth.toFixed(8)} ETH | tokenId=${tokenId ?? "?"}`);
  }

  recordArb() {
    this.totals.arbsTaken++;
  }

  save() {
    const data = {
      sessionStartedAt: new Date(this.startTime).toISOString(),
      sessionEndedAt:   new Date().toISOString(),
      durationSec:      Math.floor((Date.now() - this.startTime) / 1000),
      walletAddress:    this.walletAddress,
      startBalance:     ethers.formatEther(this.startBalance),
      endBalance:       ethers.formatEther(this.currentBalance),
      totals: {
        swaps:       this.totals.swaps,
        lpAdds:      this.totals.lpAdds,
        arbsTaken:   this.totals.arbsTaken,
        failed:      this.totals.failed,
        ethSpent:    ethers.formatEther(this.totals.ethSpent),
        ethReceived: ethers.formatEther(this.totals.ethReceived),
        gasSpent:    ethers.formatEther(this.totals.gasSpent),
        realizedPnL: ethers.formatEther(this.totals.realizedPnL),
      },
      trades: this.trades,
    };
    fs.writeFileSync(this.logPath, JSON.stringify(data, null, 2));
    this.log(`💾 Trade log saved → ${this.logPath}`);
  }

  async printReport() {
    this.currentBalance = await this.provider.getBalance(this.walletAddress);
    const totalDelta    = this.currentBalance - this.startBalance;
    const sign          = totalDelta >= 0n ? "+" : "-";
    const deltaAbs      = totalDelta < 0n ? -totalDelta : totalDelta;

    const fmt  = (b) => ethers.formatEther(b);
    const fmt8 = (b) => Number(ethers.formatEther(b)).toFixed(8);

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                  PnL  &  VOLUME  REPORT                   ║");
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║  Session duration   : ${(Math.floor((Date.now() - this.startTime) / 1000) + "s").padEnd(35)} ║`);
    console.log(`║  Start balance      : ${(fmt(this.startBalance) + " ETH").padEnd(35)} ║`);
    console.log(`║  End   balance      : ${(fmt(this.currentBalance) + " ETH").padEnd(35)} ║`);
    console.log(`║  Net change         : ${(sign + fmt(deltaAbs) + " ETH").padEnd(35)} ║`);
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║  Successful swaps   : ${String(this.totals.swaps).padEnd(35)} ║`);
    console.log(`║  Successful LP adds : ${String(this.totals.lpAdds).padEnd(35)} ║`);
    console.log(`║  Arbs captured      : ${String(this.totals.arbsTaken).padEnd(35)} ║`);
    console.log(`║  Failed actions     : ${String(this.totals.failed).padEnd(35)} ║`);
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║  Total ETH spent    : ${(fmt(this.totals.ethSpent) + " ETH").padEnd(35)} ║`);
    console.log(`║  Total ETH received : ${(fmt(this.totals.ethReceived) + " ETH").padEnd(35)} ║`);
    console.log(`║  Total gas spent    : ${(fmt8(this.totals.gasSpent) + " ETH").padEnd(35)} ║`);
    console.log(`║  Realized PnL       : ${(fmt(this.totals.realizedPnL) + " ETH").padEnd(35)} ║`);
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    this.save();
  }

  async shouldHalt({ stopLossPct }) {
    if (!stopLossPct || stopLossPct <= 0) return false;
    this.currentBalance = await this.provider.getBalance(this.walletAddress);
    const lossLimit = (this.startBalance * BigInt(Math.floor(Number(stopLossPct) * 100))) / 10000n;
    const loss      = this.startBalance - this.currentBalance;
    if (loss >= lossLimit) {
      this.log(`🛑 STOP-LOSS triggered: loss ${ethers.formatEther(loss)} ETH ≥ limit ${ethers.formatEther(lossLimit)} ETH`);
      return true;
    }
    return false;
  }
}
