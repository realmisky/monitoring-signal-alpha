/**
 * volumeBot.js — Helios Trade (AsterSwap) on RISE Testnet
 * ═══════════════════════════════════════════════════════════
 *  Smart Analyst Edition
 *    • Quotes V2 + V3 every round
 *    • Detects arbitrage spreads
 *    • Picks best engine, token, and action automatically
 *    • Tracks PnL and volume
 *    • Prints a full report at the end
 *
 *  Modes:
 *    node scripts/volumeBot.js --mode auto       # smart analyst decides (default)
 *    node scripts/volumeBot.js --mode swap       # only swaps
 *    node scripts/volumeBot.js --mode liquidity  # only LP adds
 * ═══════════════════════════════════════════════════════════
 */

import "dotenv/config";
import { ethers } from "ethers";
import { SmartAnalyst } from "./analyst.js";

// ─── CLI ─────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const MODE    = modeIdx !== -1 ? args[modeIdx + 1] : "auto";

// ─── ENV ─────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  RPC_URL              = "https://testnet.riselabs.xyz",
  POOL_FEE             = "3000",
  TOTAL_ROUNDS         = "15",
  MIN_SWAP_AMOUNT_ETH  = "0.0005",
  MAX_SWAP_AMOUNT_ETH  = "0.003",
  MIN_LP_AMOUNT_ETH    = "0.001",
  MAX_LP_AMOUNT_ETH    = "0.005",
  MIN_DELAY_SECONDS    = "8",
  MAX_DELAY_SECONDS    = "25",
  RANDOM_TOKENS        = "USDR,WBTC",
  ARB_THRESHOLD_BPS    = "50",
  SWAP_TO_LP_RATIO     = "4",
  SLIPPAGE_PERCENT     = "5",
  DEADLINE_OFFSET      = "300",
} = process.env;

if (!PRIVATE_KEY) { console.error("❌  PRIVATE_KEY missing in .env"); process.exit(1); }

// ─── CONTRACTS ───────────────────────────────────────────────
const CONTRACTS = {
  V2_ROUTER:        "0x10d48ce98bdf05be9dafa8d61f147a559c23ab85",
  V3_SWAP_ROUTER:   "0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43",
  V3_QUOTER:        "0x009c4554f445dfa2e757d9f0452dc7dcc444729a",
  POSITION_MANAGER: "0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b",
  WETH:             "0x4200000000000000000000000000000000000006",
};

// ─── TOKENS ──────────────────────────────────────────────────
const TOKENS = {
  USDR: { address: "0x04ed985f0246f00e4e9d158a70a6469e258def05", decimals: 6,  symbol: "USDR" },
  WBTC: { address: "0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55", decimals: 18, symbol: "WBTC" },
};

const TOKEN_POOL = RANDOM_TOKENS.split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => TOKENS[s])
  .map((s) => TOKENS[s]);

if (TOKEN_POOL.length === 0) { console.error("❌  No valid tokens in RANDOM_TOKENS."); process.exit(1); }

// ─── ABIs ────────────────────────────────────────────────────
const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad)",
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
  `function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)`,
];

// ─── Helpers ─────────────────────────────────────────────────
const sleep    = (s) => new Promise((r) => setTimeout(r, s * 1000));
const deadline = () => Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
const slippage = (amt, pct) => (amt * BigInt(100 - Number(pct))) / 100n;
const log      = (msg) => console.log(`[${new Date().toISOString()}]  ${msg}`);
const randInt  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

async function wrapETH(weth, amountWei) {
  log(`   ↳ Wrap ${ethers.formatEther(amountWei)} ETH → WETH`);
  const tx = await weth.deposit({ value: amountWei });
  await tx.wait();
  log(`   ↳ Wrapped ✓  tx=${tx.hash}`);
}

async function unwrapWETH(weth, amountWei) {
  log(`   ↳ Unwrap ${ethers.formatEther(amountWei)} WETH → ETH`);
  const tx = await weth.withdraw(amountWei);
  await tx.wait();
  log(`   ↳ Unwrapped ✓  tx=${tx.hash}`);
}

// ─── EXECUTORS ───────────────────────────────────────────────
async function executeV2Swap(v2Router, weth, tokenContract, tokenInfo, wallet, amountWei) {
  const path_buy  = [CONTRACTS.WETH, tokenInfo.address];
  const path_sell = [tokenInfo.address, CONTRACTS.WETH];

  // Quote for slippage protection
  let minOut = 0n;
  try {
    const a = await v2Router.getAmountsOut(amountWei, path_buy);
    minOut = slippage(a[1], SLIPPAGE_PERCENT);
  } catch (_) {}

  log(`▶  [V2] BUY  ${ethers.formatEther(amountWei)} ETH → ${tokenInfo.symbol}`);
  const buyTx = await v2Router.swapExactETHForTokens(
    minOut, path_buy, wallet.address, deadline(), { value: amountWei }
  );
  const buyR = await buyTx.wait();
  log(`   ✅ BUY  block=${buyR.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  const tokenBal = await tokenContract.balanceOf(wallet.address);
  if (tokenBal === 0n) return { ethReceived: 0n };

  await ensureApproval(tokenContract, CONTRACTS.V2_ROUTER, tokenBal);

  let minEth = 0n;
  try {
    const a = await v2Router.getAmountsOut(tokenBal, path_sell);
    minEth = slippage(a[1], SLIPPAGE_PERCENT);
  } catch (_) {}

  log(`▶  [V2] SELL ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol} → ETH`);
  const balanceBefore = await wallet.provider.getBalance(wallet.address);
  const sellTx = await v2Router.swapExactTokensForETH(
    tokenBal, minEth, path_sell, wallet.address, deadline()
  );
  const sellR = await sellTx.wait();
  const balanceAfter = await wallet.provider.getBalance(wallet.address);
  log(`   ✅ SELL block=${sellR.blockNumber}  tx=${sellTx.hash}`);

  // Approximate ETH received (after gas)
  const ethReceived = balanceAfter - balanceBefore;
  return { ethReceived: ethReceived > 0n ? ethReceived : 0n };
}

async function executeV3Swap(v3Router, v3Quoter, weth, tokenContract, tokenInfo, wallet, amountWei) {
  const fee = Number(POOL_FEE);

  await wrapETH(weth, amountWei);
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, amountWei);

  let quotedOut = 0n;
  try {
    quotedOut = await v3Quoter.quoteExactInputSingle.staticCall(
      CONTRACTS.WETH, tokenInfo.address, fee, amountWei, 0n
    );
  } catch (_) {}

  log(`▶  [V3] BUY  ${ethers.formatEther(amountWei)} WETH → ${tokenInfo.symbol}`);
  const buyTx = await v3Router.exactInputSingle({
    tokenIn:           CONTRACTS.WETH,
    tokenOut:          tokenInfo.address,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          amountWei,
    amountOutMinimum:  quotedOut > 0n ? slippage(quotedOut, SLIPPAGE_PERCENT) : 0n,
    sqrtPriceLimitX96: 0n,
  });
  const buyR = await buyTx.wait();
  log(`   ✅ BUY  block=${buyR.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  const tokenBal = await tokenContract.balanceOf(wallet.address);
  if (tokenBal === 0n) return { ethReceived: 0n };

  await ensureApproval(tokenContract, CONTRACTS.V3_SWAP_ROUTER, tokenBal);

  let quotedWeth = 0n;
  try {
    quotedWeth = await v3Quoter.quoteExactInputSingle.staticCall(
      tokenInfo.address, CONTRACTS.WETH, fee, tokenBal, 0n
    );
  } catch (_) {}

  log(`▶  [V3] SELL ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol} → WETH`);
  const sellTx = await v3Router.exactInputSingle({
    tokenIn:           tokenInfo.address,
    tokenOut:          CONTRACTS.WETH,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          tokenBal,
    amountOutMinimum:  quotedWeth > 0n ? slippage(quotedWeth, SLIPPAGE_PERCENT) : 0n,
    sqrtPriceLimitX96: 0n,
  });
  const sellR = await sellTx.wait();
  log(`   ✅ SELL block=${sellR.blockNumber}  tx=${sellTx.hash}`);

  const wethBal = await weth.balanceOf(wallet.address);
  if (wethBal > 0n) await unwrapWETH(weth, wethBal);

  return { ethReceived: wethBal };
}

async function executeAddLiquidity(v3Router, posManager, weth, tokenContract, tokenInfo, wallet, amountWei) {
  const fee     = Number(POOL_FEE);
  const halfEth = amountWei / 2n;

  await wrapETH(weth, amountWei);
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, halfEth);

  log(`▶  Buying ${tokenInfo.symbol} with ${ethers.formatEther(halfEth)} WETH for LP…`);
  const buyTx = await v3Router.exactInputSingle({
    tokenIn:           CONTRACTS.WETH,
    tokenOut:          tokenInfo.address,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          halfEth,
    amountOutMinimum:  0n,
    sqrtPriceLimitX96: 0n,
  });
  await buyTx.wait();
  log(`   ✅ Buy tx=${buyTx.hash}`);

  const tokenBal = await tokenContract.balanceOf(wallet.address);
  const wethBal  = await weth.balanceOf(wallet.address);
  if (tokenBal === 0n || wethBal === 0n) { log("   ⚠️  Insufficient balance, skip LP."); return; }

  await ensureApproval(weth,          CONTRACTS.POSITION_MANAGER, wethBal);
  await ensureApproval(tokenContract, CONTRACTS.POSITION_MANAGER, tokenBal);

  const wethLower = CONTRACTS.WETH.toLowerCase() < tokenInfo.address.toLowerCase();
  const [token0, token1, amt0, amt1] = wethLower
    ? [CONTRACTS.WETH, tokenInfo.address, wethBal, tokenBal]
    : [tokenInfo.address, CONTRACTS.WETH, tokenBal, wethBal];

  log(`▶  Mint LP: ${ethers.formatEther(wethBal)} WETH + ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol}`);
  const mintTx = await posManager.mint({
    token0, token1, fee,
    tickLower:      -887220,
    tickUpper:       887220,
    amount0Desired: amt0,
    amount1Desired: amt1,
    amount0Min:     slippage(amt0, SLIPPAGE_PERCENT),
    amount1Min:     slippage(amt1, SLIPPAGE_PERCENT),
    recipient:      wallet.address,
    deadline:       deadline(),
  });
  const mintR = await mintTx.wait();
  log(`   ✅ LP minted  block=${mintR.blockNumber}  tx=${mintTx.hash}`);
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  log(`🚀  Helios Smart Volume Bot  [mode=${MODE}]`);
  log(`    RPC          : ${RPC_URL}`);
  log(`    Tokens       : ${TOKEN_POOL.map((t) => t.symbol).join(", ")}`);
  log(`    Total rounds : ${TOTAL_ROUNDS}`);
  log(`    Swap range   : ${MIN_SWAP_AMOUNT_ETH} – ${MAX_SWAP_AMOUNT_ETH} ETH`);
  log(`    LP   range   : ${MIN_LP_AMOUNT_ETH} – ${MAX_LP_AMOUNT_ETH} ETH`);
  log(`    Arb threshold: ${ARB_THRESHOLD_BPS} bps`);
  log(`    Swap:LP ratio: ${SWAP_TO_LP_RATIO}:1`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();
  const balance  = await provider.getBalance(wallet.address);

  log(`    Network      : chainId=${network.chainId}`);
  log(`    Wallet       : ${wallet.address}`);
  log(`    Balance      : ${ethers.formatEther(balance)} ETH`);

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

  // ── Initialize the Smart Analyst ──────────────────────────
  const analyst = new SmartAnalyst({
    v2Router,
    v3Quoter,
    weth,
    tokens:          TOKEN_POOL,
    poolFee:         POOL_FEE,
    arbThresholdBps: ARB_THRESHOLD_BPS,
    swapToLpRatio:   SWAP_TO_LP_RATIO,
  });

  // ── Run rounds ────────────────────────────────────────────
  const totalRounds = Number(TOTAL_ROUNDS);
  log(`\n🧠  Starting ${totalRounds} smart-analyst rounds\n`);

  for (let i = 1; i <= totalRounds; i++) {
    log(`╭─── Round ${i}/${totalRounds} ──────────────────────────`);

    // 1. Ask the analyst what to do
    const decision = await analyst.decide({
      minSwap: MIN_SWAP_AMOUNT_ETH,
      maxSwap: MAX_SWAP_AMOUNT_ETH,
      minLp:   MIN_LP_AMOUNT_ETH,
      maxLp:   MAX_LP_AMOUNT_ETH,
      mode:    MODE,
    });

    log(`│  📊 Decision : ${decision.action.toUpperCase()}${decision.engine ? ` via ${decision.engine.toUpperCase()}` : ""}`);
    log(`│  🪙 Token    : ${decision.token.symbol}`);
    log(`│  💰 Amount   : ${decision.amountEth} ETH`);
    log(`│  💡 Reason   : ${decision.reason}`);
    log(`│  📈 Spread   : ${decision.quotes.spreadBps} bps  (V2=${decision.quotes.v2Out}, V3=${decision.quotes.v3Out})`);
    log(`│  ⭐ Score    : ${decision.score}`);
    log(`╰──────────────────────────────────────────────────`);

    const tokenContract = tokenContracts[decision.token.symbol];

    // 2. Execute
    try {
      if (decision.action === "swap") {
        const result = decision.engine === "v2"
          ? await executeV2Swap(v2Router, weth, tokenContract, decision.token, wallet, decision.amount)
          : await executeV3Swap(v3Router, v3Quoter, weth, tokenContract, decision.token, wallet, decision.amount);

        analyst.recordSwap({
          token:     decision.token,
          amountIn:  decision.amount,
          amountOut: result.ethReceived,
          engine:    decision.engine,
        });

        if (decision.quotes.spreadBps >= Number(ARB_THRESHOLD_BPS)) {
          analyst.recordArb();
        }
      } else {
        await executeAddLiquidity(v3Router, posManager, weth, tokenContract, decision.token, wallet, decision.amount);
        analyst.recordLp({ token: decision.token, amountWei: decision.amount });
      }
    } catch (err) {
      log(`   ❌ Round ${i} failed: ${err.shortMessage ?? err.message}`);
    }

    // 3. Sleep
    if (i < totalRounds) {
      const d = randInt(Number(MIN_DELAY_SECONDS), Number(MAX_DELAY_SECONDS));
      log(`   ⏳ Sleeping ${d}s…\n`);
      await sleep(d);
    }
  }

  // ── Final report ──────────────────────────────────────────
  analyst.printReport();

  const finalBal = await provider.getBalance(wallet.address);
  log(`🏁  Done. Final balance: ${ethers.formatEther(finalBal)} ETH`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
