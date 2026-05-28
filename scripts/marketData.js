/**
 * marketData.js — Live market data feed
 * ═══════════════════════════════════════════════════════════
 *  Provides:
 *    • On-chain pool depth (V2 reserves, V3 liquidity)
 *    • Subgraph volume queries (24h, recent swaps)
 *    • Price impact estimation (quote-vs-spot comparison)
 *    • Health snapshot per token
 * ═══════════════════════════════════════════════════════════
 */

import { ethers } from "ethers";

const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const V3_POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const V2_SUBGRAPH = "https://testnet.helios.trade/subgraphs/name/asterswap-v2-rise";
const V3_SUBGRAPH = "https://testnet.helios.trade/subgraphs/name/asterswap-v3-rise";

export class MarketData {
  constructor({ provider, v2Factory, v3Factory, v3Quoter, weth }) {
    this.provider  = provider;
    this.weth      = weth;
    this.v2Factory = new ethers.Contract(v2Factory, V2_FACTORY_ABI, provider);
    this.v3Factory = new ethers.Contract(v3Factory, V3_FACTORY_ABI, provider);
    this.v3Quoter  = v3Quoter;
    this.cache     = new Map();
    this.cacheTTL  = 30_000; // 30s
  }

  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < this.cacheTTL) return hit.v;
    const v = await fn();
    this.cache.set(key, { t: Date.now(), v });
    return v;
  }

  async getV2PoolDepth(tokenA, tokenB) {
    return this.cached(`v2-${tokenA}-${tokenB}`, async () => {
      const pairAddr = await this.v2Factory.getPair(tokenA, tokenB);
      if (pairAddr === ethers.ZeroAddress) return null;
      const pair       = new ethers.Contract(pairAddr, V2_PAIR_ABI, this.provider);
      const [r0, r1]   = await pair.getReserves();
      const t0         = await pair.token0();
      const aIsToken0  = tokenA.toLowerCase() === t0.toLowerCase();
      return {
        pair:      pairAddr,
        reserveA:  aIsToken0 ? r0 : r1,
        reserveB:  aIsToken0 ? r1 : r0,
      };
    });
  }

  async getV3PoolDepth(tokenA, tokenB, fee) {
    return this.cached(`v3-${tokenA}-${tokenB}-${fee}`, async () => {
      const poolAddr = await this.v3Factory.getPool(tokenA, tokenB, fee);
      if (poolAddr === ethers.ZeroAddress) return null;
      const pool         = new ethers.Contract(poolAddr, V3_POOL_ABI, this.provider);
      const [liq, slot0] = await Promise.all([pool.liquidity(), pool.slot0()]);
      return {
        pool:         poolAddr,
        liquidity:    liq,
        sqrtPriceX96: slot0[0],
        tick:         Number(slot0[1]),
      };
    });
  }

  // Returns price impact in basis points
  async estimatePriceImpact(tokenIn, tokenOut, fee, amountIn) {
    try {
      const probe = ethers.parseEther("0.0001");
      const [spotOut, actualOut] = await Promise.all([
        this.v3Quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, probe,    0n),
        this.v3Quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0n),
      ]);
      if (spotOut === 0n || actualOut === 0n) return null;
      const spotPrice   = (spotOut   * 10n ** 18n) / probe;
      const actualPrice = (actualOut * 10n ** 18n) / amountIn;
      if (actualPrice >= spotPrice) return 0;
      return Number(((spotPrice - actualPrice) * 10000n) / spotPrice);
    } catch (_) {
      return null;
    }
  }

  async getSubgraphVolume(tokenAddress, version = "v3") {
    return this.cached(`vol-${version}-${tokenAddress}`, async () => {
      const url = version === "v3" ? V3_SUBGRAPH : V2_SUBGRAPH;
      const query = version === "v3"
        ? `{ token(id: "${tokenAddress.toLowerCase()}") { symbol volumeUSD txCount } }`
        : `{ token(id: "${tokenAddress.toLowerCase()}") { symbol tradeVolumeUSD totalTransactions } }`;
      try {
        const res  = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ query }),
        });
        const json = await res.json();
        const t    = json?.data?.token;
        if (!t) return null;
        return {
          symbol:  t.symbol,
          volume:  Number(t.volumeUSD ?? t.tradeVolumeUSD ?? 0),
          txCount: Number(t.txCount  ?? t.totalTransactions ?? 0),
        };
      } catch (_) {
        return null;
      }
    });
  }

  // Full snapshot used by the analyst
  async snapshotToken(tokenInfo, fee) {
    const wethAddr = await this.weth.getAddress();
    const [v2, v3, vol] = await Promise.all([
      this.getV2PoolDepth(wethAddr, tokenInfo.address).catch(() => null),
      this.getV3PoolDepth(wethAddr, tokenInfo.address, fee).catch(() => null),
      this.getSubgraphVolume(tokenInfo.address, "v3").catch(() => null),
    ]);
    return {
      symbol:        tokenInfo.symbol,
      v2HasPool:     v2 !== null,
      v2Reserves:    v2 ? { weth: v2.reserveA, token: v2.reserveB } : null,
      v3HasPool:     v3 !== null,
      v3Liquidity:   v3?.liquidity ?? 0n,
      v3Tick:        v3?.tick ?? null,
      subgraphVol:   vol?.volume ?? 0,
      subgraphTxs:   vol?.txCount ?? 0,
    };
  }
}
