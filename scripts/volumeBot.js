/**
 * volumeBot.js — Helios Trade Smart Volume Bot v3
 * ═══════════════════════════════════════════════════════════
 *  ⚙️  Modules used:
 *    • marketData.js   live pool depth + subgraph volume + price impact
 *    • analyst.js      arb detection + volume-weighted sizing + scoring
 *    • pnlTracker.js   real PnL with gas, slippage, JSON trade log
 *
 *  🛡️  Risk controls:
 *    • Stop-loss      → halts when cumulative loss > STOP_LOSS_PCT
 *    • Impact cap     → reduces trade size if price impact > MAX_PRICE_IMPACT_BPS
 *    • Min-balance    → skips round if wallet ETH < MIN_BALANCE_ETH
 * ═══════════════════════════════════════════════════════════
 */

import "dotenv/config";
import { ethers } from "ethers";
import { SmartAnalyst } from "./analyst.js";
import { MarketData }   from "./marketData.js";
import { PnLTracker }   from "./pnlTracker.js";

// ─── CLI ──────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const MODE    = modeIdx !== -1 ? args[modeIdx + 1] : "auto";

// ─── ENV ──────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  RPC_URL                = "https://testnet.riselabs.xyz",
  POOL_FEE               = "3000",
  TOTAL_ROUNDS           = "15",
  MIN_SWAP_AMOUNT_ETH    = "0.0005",
  MAX_SWAP_AMOUNT_ETH    = "0.003",
  MIN_LP_AMOUNT_ETH      = "0.001",
  MAX_LP_AMOUNT_ETH      = "0.005",
  MIN_DELAY_SECONDS      = "8",
  MAX_DELAY_SECONDS      = "25",
  RANDOM_TOKENS          = "USDR,WBTC",
  ARB_THRESHOLD_BPS      = "50",
  SWAP_TO_LP_RATIO       = "4",
  MAX_PRICE_IMPACT_BPS   = "100",
  STOP_LOSS_PCT          = "5",            // halt if down >5% of start balance
  MIN_BALANCE_ETH        = "0.005",        // skip if balance below this
  SLIPPAGE_PERCENT       = "5",
  DEADLINE_OFFSET        = "300",
  TRADE_LOG_PATH         = "./trade-log.json",
} = process.env;

if (!PRIVATE_KEY) { console.error("❌  PRIVATE_KEY missing in .env"); process.exit(1); }

// ─── CONTRACTS ────────────────────────────────────────────────
const CONTRACTS = {
  V2_FACTORY:       "0x9f653de29013b1e92f0c9749958961c3a64e676d",
  V2_ROUTER:        "0x10d48ce98bdf05be9dafa8d61f147a559c23ab85",
  V3_FACTORY:       "0xb79fa267550c1bc6079ee5badeaa2b2fd52a2181",
  V3_SWAP_ROUTER:   "0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43",
  V3_QUOTER:        "0x009c4554f445dfa2e757d9f0452dc7dcc444729a",
  POSITION_MANAGER: "0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b",
  WETH:             "0x4200000000000000000000000000000000000006",
};

const TOKENS = {
  USDR: { address: "0x04ed985f0246f00e4e9d158a70a6469e258def05", decimals: 6,  symbol: "USDR" },
  WBTC: { address: "0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55", decimals: 18, symbol: "WBTC" },
};

const TOKEN_POOL = RANDOM_TOKENS.split(",").map((s) => s.trim().toUpperCase()).filter((s) => TOKENS[s]).map((s) => TOKENS[s]);
if (TOKEN_POOL.length === 0) { console.error("❌  RANDOM_TOKENS has no valid tokens."); process.exit(1); }

// ─── ABIs ─────────────────────────────────────────────────────
const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint,address[]) view returns (uint[])",
  "function swapExactETHForTokens(uint,address[],address,uint) payable returns (uint[])",
  "function swapExactTokensForETH(uint,uint,address[],address,uint) returns (uint[])",
];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)",
];
const V3_ROUTER_ABI = [
  `function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)`,
];
const POSITION_MANAGER_ABI = [
  `function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`,
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// ─── Helpers ──────────────────────────────────────────────────
const sleep    = (s) => new Promise((r) => setTimeout(r, s * 1000));
const deadline = () => Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
const slippage = (amt, pct) => (amt * BigInt(100 - Number(pct))) / 100n;
const log      = (m) => console.log(`[${new Date().toISOString()}]  ${m}`);
const randInt  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

async function ensureApproval(token, spender, amount) {
  const owner     = await token.runner.getAddress();
  const allowance = await token.allowance(owner, spender);
  if (allowance < amount) {
    log(`   ↳ Approving spender ${spender.slice(0, 10)}…`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log(`   ↳ Approved ✓  tx=${tx.hash}`);
  }
}

// ─── EXECUTORS (return per-leg gas + tx data for PnL) ─────────

async function executeV2Swap({ v2Router, weth, tokenContract, tokenInfo, wallet, amountWei, tracker }) {
  const path_buy  = [CONTRACTS.WETH, tokenInfo.address];
  const path_sell = [tokenInfo.address, CONTRACTS.WETH];

  // Quote
  let expectedBuyOut = 0n;
  try { const a = await v2Router.getAmountsOut(amountWei, path_buy); expectedBuyOut = a[1]; } catch (_) {}
  const minBuyOut = expectedBuyOut > 0n ? slippage(expectedBuyOut, SLIPPAGE_PERCENT) : 0n;

  log(`▶  [V2] BUY  ${ethers.formatEther(amountWei)} ETH → ${tokenInfo.symbol}`);
  const buy = await tracker.sendAndTrack("V2 buy", () =>
    v2Router.swapExactETHForTokens(minBuyOut, path_buy, wallet.address, deadline(), { value: amountWei })
  );
  if (!buy.ok) return { ok: false };

  const tokenAfterBuy = await tokenContract.balanceOf(wallet.address);
  tracker.recordSwapLeg({
    direction: "buy", engine: "v2", tokenSymbol: tokenInfo.symbol,
    amountIn: amountWei, amountOut: tokenAfterBuy, expectedOut: expectedBuyOut,
    gasCost: buy.gasCost, txHash: buy.tx.hash, priceImpactBps: null,
  });

  await sleep(2);

  if (tokenAfterBuy === 0n) return { ok: false };
  await ensureApproval(tokenContract, CONTRACTS.V2_ROUTER, tokenAfterBuy);

  let expectedSellOut = 0n;
  try { const a = await v2Router.getAmountsOut(tokenAfterBuy, path_sell); expectedSellOut = a[1]; } catch (_) {}
  const minSellOut = expectedSellOut > 0n ? slippage(expectedSellOut, SLIPPAGE_PERCENT) : 0n;

  log(`▶  [V2] SELL ${ethers.formatUnits(tokenAfterBuy, tokenInfo.decimals)} ${tokenInfo.symbol} → ETH`);
  const sell = await tracker.sendAndTrack("V2 sell", () =>
    v2Router.swapExactTokensForETH(tokenAfterBuy, minSellOut, path_sell, wallet.address, deadline())
  );
  if (!sell.ok) return { ok: false };

  // Approximate ETH received from balance delta (already net of gas)
  const sellEthReceived = sell.ethDelta + sell.gasCost; // gross ETH out before gas

  tracker.recordSwapLeg({
    direction: "sell", engine: "v2", tokenSymbol: tokenInfo.symbol,
    amountIn: tokenAfterBuy, amountOut: sellEthReceived, expectedOut: expectedSellOut,
    gasCost: sell.gasCost, txHash: sell.tx.hash, priceImpactBps: null,
  });

  return {
    ok:       true,
    ethIn:    amountWei,
    ethOut:   sellEthReceived,
    totalGas: buy.gasCost + sell.gasCost,
  };
}

async function executeV3Swap({ v3Router, v3Quoter, weth, tokenContract, tokenInfo, wallet, amountWei, priceImpactBps, tracker }) {
  const fee = Number(POOL_FEE);

  // Wrap
  const wrap = await tracker.sendAndTrack("wrap ETH", () => weth.deposit({ value: amountWei }));
  if (!wrap.ok) return { ok: false };
  log(`   ↳ Wrapped ${ethers.formatEther(amountWei)} ETH → WETH  tx=${wrap.tx.hash}`);

  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, amountWei);

  // Quote buy
  let expectedBuyOut = 0n;
  try {
    expectedBuyOut = await v3Quoter.quoteExactInputSingle.staticCall(
      CONTRACTS.WETH, tokenInfo.address, fee, amountWei, 0n
    );
  } catch (_) {}
  const minBuyOut = expectedBuyOut > 0n ? slippage(expectedBuyOut, SLIPPAGE_PERCENT) : 0n;

  log(`▶  [V3] BUY  ${ethers.formatEther(amountWei)} WETH → ${tokenInfo.symbol}`);
  const buy = await tracker.sendAndTrack("V3 buy", () =>
    v3Router.exactInputSingle({
      tokenIn:           CONTRACTS.WETH,
      tokenOut:          tokenInfo.address,
      fee,
      recipient:         wallet.address,
      deadline:          deadline(),
      amountIn:          amountWei,
      amountOutMinimum:  minBuyOut,
      sqrtPriceLimitX96: 0n,
    })
  );
  if (!buy.ok) return { ok: false };

  const tokenAfterBuy = await tokenContract.balanceOf(wallet.address);
  tracker.recordSwapLeg({
    direction: "buy", engine: "v3", tokenSymbol: tokenInfo.symbol,
    amountIn: amountWei, amountOut: tokenAfterBuy, expectedOut: expectedBuyOut,
    gasCost: buy.gasCost, txHash: buy.tx.hash, priceImpactBps,
  });

  await sleep(2);

  if (tokenAfterBuy === 0n) return { ok: false };
  await ensureApproval(tokenContract, CONTRACTS.V3_SWAP_ROUTER, tokenAfterBuy);

  let expectedSellOut = 0n;
  try {
    expectedSellOut = await v3Quoter.quoteExactInputSingle.staticCall(
      tokenInfo.address, CONTRACTS.WETH, fee, tokenAfterBuy, 0n
    );
  } catch (_) {}
  const minSellOut = expectedSellOut > 0n ? slippage(expectedSellOut, SLIPPAGE_PERCENT) : 0n;

  log(`▶  [V3] SELL ${ethers.formatUnits(tokenAfterBuy, tokenInfo.decimals)} ${tokenInfo.symbol} → WETH`);
  const sell = await tracker.sendAndTrack("V3 sell", () =>
    v3Router.exactInputSingle({
      tokenIn:           tokenInfo.address,
      tokenOut:          CONTRACTS.WETH,
      fee,
      recipient:         wallet.address,
      deadline:          deadline(),
      amountIn:          tokenAfterBuy,
      amountOutMinimum:  minSellOut,
      sqrtPriceLimitX96: 0n,
    })
  );
  if (!sell.ok) return { ok: false };

  const wethBalance = await weth.balanceOf(wallet.address);
  tracker.recordSwapLeg({
    direction: "sell", engine: "v3", tokenSymbol: tokenInfo.symbol,
    amountIn: tokenAfterBuy, amountOut: wethBalance, expectedOut: expectedSellOut,
    gasCost: sell.gasCost, txHash: sell.tx.hash, priceImpactBps: null,
  });

  let unwrapGas = 0n;
  if (wethBalance > 0n) {
    const unwrap = await tracker.sendAndTrack("unwrap WETH", () => weth.withdraw(wethBalance));
    if (unwrap.ok) {
      unwrapGas = unwrap.gasCost;
      log(`   ↳ Unwrapped WETH → ETH  tx=${unwrap.tx.hash}`);
    }
  }

  return {
    ok:       true,
    ethIn:    amountWei,
    ethOut:   wethBalance,
    totalGas: wrap.gasCost + buy.gasCost + sell.gasCost + unwrapGas,
  };
}

async function executeAddLiquidity({ v3Router, posManager, weth, tokenContract, tokenInfo, wallet, amountWei, tracker }) {
  const fee     = Number(POOL_FEE);
  const halfEth = amountWei / 2n;

  const wrap = await tracker.sendAndTrack("wrap for LP", () => weth.deposit({ value: amountWei }));
  if (!wrap.ok) return { ok: false };

  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, halfEth);
  log(`▶  Buying ${tokenInfo.symbol} with ${ethers.formatEther(halfEth)} WETH for LP…`);

  const buy = await tracker.sendAndTrack("LP buy leg", () =>
    v3Router.exactInputSingle({
      tokenIn:           CONTRACTS.WETH,
      tokenOut:          tokenInfo.address,
      fee,
      recipient:         wallet.address,
      deadline:          deadline(),
      amountIn:          halfEth,
      amountOutMinimum:  0n,
      sqrtPriceLimitX96: 0n,
    })
  );
  if (!buy.ok) return { ok: false };

  const tokenBal = await tokenContract.balanceOf(wallet.address);
  const wethBal  = await weth.balanceOf(wallet.address);
  if (tokenBal === 0n || wethBal === 0n) { log("   ⚠️  Insufficient balance, skip LP."); return { ok: false }; }

  await ensureApproval(weth,          CONTRACTS.POSITION_MANAGER, wethBal);
  await ensureApproval(tokenContract, CONTRACTS.POSITION_MANAGER, tokenBal);

  const wethLower = CONTRACTS.WETH.toLowerCase() < tokenInfo.address.toLowerCase();
  const [token0, token1, amt0, amt1] = wethLower
    ? [CONTRACTS.WETH, tokenInfo.address, wethBal, tokenBal]
    : [tokenInfo.address, CONTRACTS.WETH, tokenBal, wethBal];

  log(`▶  Mint LP: ${ethers.formatEther(wethBal)} WETH + ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol}`);
  const mint = await tracker.sendAndTrack("mint LP", () =>
    posManager.mint({
      token0, token1, fee,
      tickLower:      -887220,
      tickUpper:       887220,
      amount0Desired: amt0,
      amount1Desired: amt1,
      amount0Min:     slippage(amt0, SLIPPAGE_PERCENT),
      amount1Min:     slippage(amt1, SLIPPAGE_PERCENT),
      recipient:      wallet.address,
      deadline:       deadline(),
    })
  );
  if (!mint.ok) return { ok: false };

  // Try to extract tokenId from logs
  let tokenId = null;
  try {
    const ev = mint.receipt.logs.find((l) => l.topics?.[0] === ethers.id("Transfer(address,address,uint256)"));
    if (ev) tokenId = ethers.toBigInt(ev.topics[3]).toString();
  } catch (_) {}

  tracker.recordLP({
    tokenSymbol:  tokenInfo.symbol,
    ethDeposited: amountWei,
    gasCost:      wrap.gasCost + buy.gasCost + mint.gasCost,
    txHash:       mint.tx.hash,
    tokenId,
  });

  return { ok: true };
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  log(`🚀  Helios Smart Volume Bot v3  [mode=${MODE}]`);
  log(`    RPC          : ${RPC_URL}`);
  log(`    Tokens       : ${TOKEN_POOL.map((t) => t.symbol).join(", ")}`);
  log(`    Total rounds : ${TOTAL_ROUNDS}`);
  log(`    Swap range   : ${MIN_SWAP_AMOUNT_ETH} – ${MAX_SWAP_AMOUNT_ETH} ETH`);
  log(`    LP range     : ${MIN_LP_AMOUNT_ETH} – ${MAX_LP_AMOUNT_ETH} ETH`);
  log(`    Arb threshold: ${ARB_THRESHOLD_BPS} bps`);
  log(`    Max impact   : ${MAX_PRICE_IMPACT_BPS} bps`);
  log(`    Stop-loss    : ${STOP_LOSS_PCT}% of start balance`);
  log(`    Min balance  : ${MIN_BALANCE_ETH} ETH`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();
  log(`    Network      : chainId=${network.chainId}`);
  log(`    Wallet       : ${wallet.address}`);

  // Contracts
  const v2Router   = new ethers.Contract(CONTRACTS.V2_ROUTER,        V2_ROUTER_ABI,        wallet);
  const v3Router   = new ethers.Contract(CONTRACTS.V3_SWAP_ROUTER,   V3_ROUTER_ABI,        wallet);
  const v3Quoter   = new ethers.Contract(CONTRACTS.V3_QUOTER,        V3_QUOTER_ABI,        wallet);
  const posManager = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
  const weth       = new ethers.Contract(CONTRACTS.WETH,             WETH_ABI,             wallet);

  const tokenContracts = {};
  for (const sym of Object.keys(TOKENS)) {
    tokenContracts[sym] = new ethers.Contract(TOKENS[sym].address, ERC20_ABI, wallet);
  }

  // Modules
  const market = new MarketData({
    provider,
    v2Factory: CONTRACTS.V2_FACTORY,
    v3Factory: CONTRACTS.V3_FACTORY,
    v3Quoter,
    weth,
  });

  const analyst = new SmartAnalyst({
    v2Router, v3Quoter, weth, market,
    tokens:            TOKEN_POOL,
    poolFee:           POOL_FEE,
    arbThresholdBps:   ARB_THRESHOLD_BPS,
    swapToLpRatio:     SWAP_TO_LP_RATIO,
    maxPriceImpactBps: MAX_PRICE_IMPACT_BPS,
  });

  const tracker = new PnLTracker({
    provider,
    walletAddress: wallet.address,
    logPath:       TRADE_LOG_PATH,
  });
  await tracker.init();

  const totalRounds  = Number(TOTAL_ROUNDS);
  const minBalanceWei = ethers.parseEther(MIN_BALANCE_ETH);

  log(`\n🧠  Starting ${totalRounds} smart-analyst rounds\n`);

  for (let i = 1; i <= totalRounds; i++) {
    log(`╭─── Round ${i}/${totalRounds} ──────────────────────────`);

    // Risk: stop-loss
    if (await tracker.shouldHalt({ stopLossPct: STOP_LOSS_PCT })) {
      log("│  Halting due to stop-loss.");
      break;
    }

    // Risk: min balance
    const bal = await provider.getBalance(wallet.address);
    if (bal < minBalanceWei) {
      log(`│  ⚠️  Balance ${ethers.formatEther(bal)} < min ${MIN_BALANCE_ETH} ETH — stopping.`);
      break;
    }

    // Decide
    const decision = await analyst.decide({
      minSwap: MIN_SWAP_AMOUNT_ETH,
      maxSwap: MAX_SWAP_AMOUNT_ETH,
      minLp:   MIN_LP_AMOUNT_ETH,
      maxLp:   MAX_LP_AMOUNT_ETH,
      mode:    MODE,
    });

    log(`│  📊 Decision   : ${decision.action.toUpperCase()}${decision.engine ? ` via ${decision.engine.toUpperCase()}` : ""}`);
    log(`│  🪙 Token      : ${decision.token.symbol}`);
    log(`│  💰 Amount     : ${decision.amountEth} ETH`);
    log(`│  💡 Reason     : ${decision.reason}`);
    log(`│  📈 Spread     : ${decision.quotes.spreadBps} bps`);
    if (decision.priceImpactBps !== null && decision.priceImpactBps !== undefined) {
      log(`│  💥 Impact     : ${decision.priceImpactBps} bps`);
    }
    log(`│  💧 V3 liquidity: ${decision.snap.v3Liquidity}`);
    log(`│  📊 Subgraph vol: $${decision.snap.subgraphVol.toFixed(2)} (${decision.snap.subgraphTxs} txs)`);
    log(`│  ⭐ Score      : ${decision.score}`);
    log(`╰──────────────────────────────────────────────────`);

    const tokenContract = tokenContracts[decision.token.symbol];

    if (decision.action === "swap") {
      let result;
      if (decision.engine === "v2") {
        result = await executeV2Swap({
          v2Router, weth, tokenContract, tokenInfo: decision.token,
          wallet, amountWei: decision.amount, tracker,
        });
      } else {
        result = await executeV3Swap({
          v3Router, v3Quoter, weth, tokenContract, tokenInfo: decision.token,
          wallet, amountWei: decision.amount, priceImpactBps: decision.priceImpactBps, tracker,
        });
      }

      if (result?.ok) {
        tracker.recordRoundTrip({
          tokenSymbol: decision.token.symbol,
          ethIn:       result.ethIn,
          ethOut:      result.ethOut,
          totalGas:    result.totalGas,
        });
        if (decision.quotes.spreadBps >= Number(ARB_THRESHOLD_BPS)) tracker.recordArb();
        analyst.recordSwap(decision.token.symbol);
      }
    } else {
      const r = await executeAddLiquidity({
        v3Router, posManager, weth, tokenContract, tokenInfo: decision.token,
        wallet, amountWei: decision.amount, tracker,
      });
      if (r?.ok) analyst.recordLp(decision.token.symbol);
    }

    if (i < totalRounds) {
      const d = randInt(Number(MIN_DELAY_SECONDS), Number(MAX_DELAY_SECONDS));
      log(`   ⏳ Sleeping ${d}s…\n`);
      await sleep(d);
    }
  }

  await tracker.printReport();
  log(`🏁  Done.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
