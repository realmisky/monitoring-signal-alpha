/**
 * volumeBot.js — Helios Trade (AsterSwap) on RISE Testnet
 * ═══════════════════════════════════════════════════════════
 *  Chain     : RISE Testnet  (Chain ID 11155931)
 *  RPC       : https://testnet.riselabs.xyz
 *  Explorer  : https://explorer.testnet.riselabs.xyz
 *  DEX       : testnet.helios.trade (AsterSwap)
 *
 *  Features:
 *    • Random token selection per round (USDR, WBTC, …)
 *    • Random amount per round (within MIN/MAX bounds)
 *    • V2 + V3 swap engines (alternates or fixed)
 *    • V3 add liquidity with random tokens & amount
 *
 *  Modes:
 *    node scripts/volumeBot.js --mode swap       # randomized swaps
 *    node scripts/volumeBot.js --mode liquidity  # randomized liquidity adds
 *    node scripts/volumeBot.js --mode both       # swaps then liquidity (default)
 * ═══════════════════════════════════════════════════════════
 */

import "dotenv/config";
import { ethers } from "ethers";

// ─── CLI ─────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const MODE    = modeIdx !== -1 ? args[modeIdx + 1] : "both";

// ─── ENV ─────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  RPC_URL              = "https://testnet.riselabs.xyz",
  SWAP_MODE            = "both",   // "v2" | "v3" | "both"
  POOL_FEE             = "3000",
  SWAP_ROUNDS          = "10",
  LIQUIDITY_ROUNDS     = "3",
  // Random amount range (in ETH units)
  MIN_SWAP_AMOUNT_ETH  = "0.0005",
  MAX_SWAP_AMOUNT_ETH  = "0.003",
  MIN_LP_AMOUNT_ETH    = "0.001",
  MAX_LP_AMOUNT_ETH    = "0.005",
  // Random delay range (in seconds)
  MIN_DELAY_SECONDS    = "8",
  MAX_DELAY_SECONDS    = "25",
  // Tokens to randomize between (comma-separated)
  RANDOM_TOKENS        = "USDR,WBTC",
  SLIPPAGE_PERCENT     = "5",
  DEADLINE_OFFSET      = "300",
} = process.env;

if (!PRIVATE_KEY) {
  console.error("❌  PRIVATE_KEY missing in .env");
  process.exit(1);
}

// ─── CONTRACTS (Helios / AsterSwap on RISE Testnet) ──────────
const CONTRACTS = {
  V2_ROUTER:        "0x10d48ce98bdf05be9dafa8d61f147a559c23ab85",
  V3_SWAP_ROUTER:   "0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43",
  V3_QUOTER:        "0x009c4554f445dfa2e757d9f0452dc7dcc444729a",
  POSITION_MANAGER: "0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b",
  WETH:             "0x4200000000000000000000000000000000000006",
};

// ─── TOKEN REGISTRY (extend here to add more tokens) ─────────
const TOKENS = {
  USDR: { address: "0x04ed985f0246f00e4e9d158a70a6469e258def05", decimals: 6,  symbol: "USDR" },
  WBTC: { address: "0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55", decimals: 18, symbol: "WBTC" },
};

// Build pool list from RANDOM_TOKENS env
const TOKEN_POOL = RANDOM_TOKENS.split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => TOKENS[s])
  .map((s) => TOKENS[s]);

if (TOKEN_POOL.length === 0) {
  console.error("❌  RANDOM_TOKENS must contain at least one valid token (USDR, WBTC).");
  process.exit(1);
}

// ─── ABIs ────────────────────────────────────────────────────
const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];

const V3_QUOTER_ABI = [
  `function quoteExactInputSingle(
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint256 amountIn,
    uint160 sqrtPriceLimitX96
  ) external returns (uint256 amountOut)`,
];

const V3_ROUTER_ABI = [
  `function exactInputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient,
     uint256 deadline, uint256 amountIn, uint256 amountOutMinimum,
     uint160 sqrtPriceLimitX96) params
  ) payable returns (uint256 amountOut)`,
];

const POSITION_MANAGER_ABI = [
  `function mint(
    (address token0, address token1, uint24 fee,
     int24 tickLower, int24 tickUpper,
     uint256 amount0Desired, uint256 amount1Desired,
     uint256 amount0Min, uint256 amount1Min,
     address recipient, uint256 deadline)
  ) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`,
];

// ─── Helpers ─────────────────────────────────────────────────
const sleep    = (s) => new Promise((r) => setTimeout(r, s * 1000));
const deadline = () => Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
const slippage = (amt, pct) => (amt * BigInt(100 - Number(pct))) / 100n;

function log(msg) {
  console.log(`[${new Date().toISOString()}]  ${msg}`);
}

// ─── Randomization helpers ────────────────────────────────────
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomToken() {
  return TOKEN_POOL[Math.floor(Math.random() * TOKEN_POOL.length)];
}

function randomAmountWei(minEth, maxEth) {
  const amt   = randFloat(Number(minEth), Number(maxEth));
  // Round to 6 decimals to keep numbers clean in logs
  const fixed = amt.toFixed(6);
  return ethers.parseEther(fixed);
}

function randomDelay() {
  return randInt(Number(MIN_DELAY_SECONDS), Number(MAX_DELAY_SECONDS));
}

function pickEngine(round) {
  if (SWAP_MODE === "v2") return "v2";
  if (SWAP_MODE === "v3") return "v3";
  // "both" → 50/50 random
  return Math.random() < 0.5 ? "v2" : "v3";
}

// ─── Approval / wrap helpers ──────────────────────────────────
async function ensureApproval(token, spender, amount) {
  const owner     = await token.runner.getAddress();
  const allowance = await token.allowance(owner, spender);
  if (allowance < amount) {
    const sym = await token.symbol().catch(() => "TOKEN");
    log(`   ↳ Approving ${sym}…`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log(`   ↳ Approved ✓  tx=${tx.hash}`);
  }
}

async function wrapETH(weth, amountWei) {
  log(`   ↳ Wrapping ${ethers.formatEther(amountWei)} ETH → WETH…`);
  const tx = await weth.deposit({ value: amountWei });
  await tx.wait();
  log(`   ↳ Wrapped ✓  tx=${tx.hash}`);
}

async function unwrapWETH(weth, amountWei) {
  log(`   ↳ Unwrapping ${ethers.formatEther(amountWei)} WETH → ETH…`);
  const tx = await weth.withdraw(amountWei);
  await tx.wait();
  log(`   ↳ Unwrapped ✓  tx=${tx.hash}`);
}

// ─── V2 SWAP ROUND ───────────────────────────────────────────
async function v2SwapRound(v2Router, weth, tokenInfo, tokenContract, wallet, amountWei, round) {
  log(`── [V2] Round ${round}  ETH ⇄ ${tokenInfo.symbol}  amount=${ethers.formatEther(amountWei)} ETH`);

  const path_buy  = [CONTRACTS.WETH, tokenInfo.address];
  const path_sell = [tokenInfo.address, CONTRACTS.WETH];

  // BUY: ETH → TOKEN
  let minOut = 0n;
  try {
    const amountsOut = await v2Router.getAmountsOut(amountWei, path_buy);
    minOut = slippage(amountsOut[1], SLIPPAGE_PERCENT);
  } catch (_) { /* no V2 pool may exist for some pairs */ }

  log(`▶  BUY  ${ethers.formatEther(amountWei)} ETH → ${tokenInfo.symbol}`);
  const buyTx = await v2Router.swapExactETHForTokens(
    minOut, path_buy, wallet.address, deadline(), { value: amountWei }
  );
  const buyR = await buyTx.wait();
  log(`   ✅ BUY  block=${buyR.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  // SELL: TOKEN → ETH
  const tokenBal = await tokenContract.balanceOf(wallet.address);
  if (tokenBal === 0n) { log("   ⚠️  Balance 0, skip sell."); return; }

  await ensureApproval(tokenContract, CONTRACTS.V2_ROUTER, tokenBal);

  let minEth = 0n;
  try {
    const sellAmounts = await v2Router.getAmountsOut(tokenBal, path_sell);
    minEth = slippage(sellAmounts[1], SLIPPAGE_PERCENT);
  } catch (_) {}

  log(`▶  SELL ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol} → ETH`);
  const sellTx = await v2Router.swapExactTokensForETH(
    tokenBal, minEth, path_sell, wallet.address, deadline()
  );
  const sellR = await sellTx.wait();
  log(`   ✅ SELL block=${sellR.blockNumber}  tx=${sellTx.hash}`);
}

// ─── V3 SWAP ROUND ───────────────────────────────────────────
async function v3SwapRound(v3Router, v3Quoter, weth, tokenInfo, tokenContract, wallet, amountWei, round) {
  log(`── [V3] Round ${round}  ETH ⇄ ${tokenInfo.symbol}  amount=${ethers.formatEther(amountWei)} ETH  fee=${POOL_FEE}`);

  const fee = Number(POOL_FEE);

  await wrapETH(weth, amountWei);
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, amountWei);

  // BUY: WETH → TOKEN
  let quotedOut = 0n;
  try {
    quotedOut = await v3Quoter.quoteExactInputSingle.staticCall(
      CONTRACTS.WETH, tokenInfo.address, fee, amountWei, 0n
    );
  } catch (_) {}

  log(`▶  BUY  ${ethers.formatEther(amountWei)} WETH → ${tokenInfo.symbol}`);
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

  // SELL: TOKEN → WETH
  const tokenBal = await tokenContract.balanceOf(wallet.address);
  if (tokenBal === 0n) { log("   ⚠️  Balance 0, skip sell."); return; }

  await ensureApproval(tokenContract, CONTRACTS.V3_SWAP_ROUTER, tokenBal);

  let quotedWeth = 0n;
  try {
    quotedWeth = await v3Quoter.quoteExactInputSingle.staticCall(
      tokenInfo.address, CONTRACTS.WETH, fee, tokenBal, 0n
    );
  } catch (_) {}

  log(`▶  SELL ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol} → WETH`);
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

  // Unwrap any leftover WETH
  const wethBal = await weth.balanceOf(wallet.address);
  if (wethBal > 0n) await unwrapWETH(weth, wethBal);
}

// ─── ADD V3 LIQUIDITY ─────────────────────────────────────────
async function addLiquidityV3(v3Router, posManager, weth, tokenInfo, tokenContract, wallet, amountWei, round) {
  log(`── [LP ${round}]  WETH/${tokenInfo.symbol}  amount=${ethers.formatEther(amountWei)} ETH`);

  const fee     = Number(POOL_FEE);
  const halfEth = amountWei / 2n;

  await wrapETH(weth, amountWei);

  // Buy token with half the WETH
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, halfEth);
  log(`▶  Buying ${tokenInfo.symbol} with ${ethers.formatEther(halfEth)} WETH…`);

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

  if (tokenBal === 0n || wethBal === 0n) {
    log("   ⚠️  Insufficient balances for LP. Skip.");
    return;
  }

  await ensureApproval(weth,          CONTRACTS.POSITION_MANAGER, wethBal);
  await ensureApproval(tokenContract, CONTRACTS.POSITION_MANAGER, tokenBal);

  // Sort tokens (V3 requires token0 < token1)
  const wethLower = CONTRACTS.WETH.toLowerCase() < tokenInfo.address.toLowerCase();
  const [token0, token1, amt0, amt1] = wethLower
    ? [CONTRACTS.WETH, tokenInfo.address, wethBal, tokenBal]
    : [tokenInfo.address, CONTRACTS.WETH, tokenBal, wethBal];

  const TICK_LOWER = -887220;
  const TICK_UPPER =  887220;

  log(`▶  Mint LP: ${ethers.formatEther(wethBal)} WETH + ${ethers.formatUnits(tokenBal, tokenInfo.decimals)} ${tokenInfo.symbol}`);

  const mintTx = await posManager.mint({
    token0,
    token1,
    fee,
    tickLower:      TICK_LOWER,
    tickUpper:      TICK_UPPER,
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
  log(`🚀  Helios Trade Volume Bot  [mode=${MODE}  swapEngine=${SWAP_MODE}]`);
  log(`    RPC      : ${RPC_URL}`);
  log(`    Tokens   : ${TOKEN_POOL.map((t) => t.symbol).join(", ")}`);
  log(`    Swap amt : ${MIN_SWAP_AMOUNT_ETH} – ${MAX_SWAP_AMOUNT_ETH} ETH (random)`);
  log(`    LP   amt : ${MIN_LP_AMOUNT_ETH} – ${MAX_LP_AMOUNT_ETH} ETH (random)`);
  log(`    Delay    : ${MIN_DELAY_SECONDS} – ${MAX_DELAY_SECONDS} s (random)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();
  const balance  = await provider.getBalance(wallet.address);

  log(`    Network  : chainId=${network.chainId}`);
  log(`    Wallet   : ${wallet.address}`);
  log(`    Balance  : ${ethers.formatEther(balance)} ETH`);

  if (network.chainId !== 11155931n) {
    log(`    ⚠️  Expected RISE Testnet (11155931), got ${network.chainId}`);
  }

  // Contract instances
  const v2Router   = new ethers.Contract(CONTRACTS.V2_ROUTER,        V2_ROUTER_ABI,        wallet);
  const v3Router   = new ethers.Contract(CONTRACTS.V3_SWAP_ROUTER,   V3_ROUTER_ABI,        wallet);
  const v3Quoter   = new ethers.Contract(CONTRACTS.V3_QUOTER,        V3_QUOTER_ABI,        wallet);
  const posManager = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
  const weth       = new ethers.Contract(CONTRACTS.WETH,             WETH_ABI,             wallet);

  // Pre-build token contract instances
  const tokenContracts = {};
  for (const sym of Object.keys(TOKENS)) {
    tokenContracts[sym] = new ethers.Contract(TOKENS[sym].address, ERC20_ABI, wallet);
  }

  // ── SWAP ROUNDS ───────────────────────────────────────────
  if (MODE === "swap" || MODE === "both") {
    const rounds = Number(SWAP_ROUNDS);
    log(`\n📊  Running ${rounds} randomized swap rounds\n`);

    for (let i = 1; i <= rounds; i++) {
      const tokenInfo     = pickRandomToken();
      const tokenContract = tokenContracts[tokenInfo.symbol];
      const amountWei     = randomAmountWei(MIN_SWAP_AMOUNT_ETH, MAX_SWAP_AMOUNT_ETH);
      const engine        = pickEngine(i);

      try {
        if (engine === "v2") {
          await v2SwapRound(v2Router, weth, tokenInfo, tokenContract, wallet, amountWei, i);
        } else {
          await v3SwapRound(v3Router, v3Quoter, weth, tokenInfo, tokenContract, wallet, amountWei, i);
        }
      } catch (err) {
        log(`   ❌ Round ${i} failed: ${err.shortMessage ?? err.message}`);
      }

      if (i < rounds) {
        const d = randomDelay();
        log(`   ⏳ Sleeping ${d}s…\n`);
        await sleep(d);
      }
    }

    log(`\n✅  Swap rounds complete.\n`);
  }

  // ── LIQUIDITY ROUNDS ──────────────────────────────────────
  if (MODE === "liquidity" || MODE === "both") {
    const lpRounds = Number(LIQUIDITY_ROUNDS);
    log(`\n💧  Running ${lpRounds} randomized liquidity rounds\n`);

    for (let i = 1; i <= lpRounds; i++) {
      const tokenInfo     = pickRandomToken();
      const tokenContract = tokenContracts[tokenInfo.symbol];
      const amountWei     = randomAmountWei(MIN_LP_AMOUNT_ETH, MAX_LP_AMOUNT_ETH);

      try {
        await addLiquidityV3(v3Router, posManager, weth, tokenInfo, tokenContract, wallet, amountWei, i);
      } catch (err) {
        log(`   ❌ LP round ${i} failed: ${err.shortMessage ?? err.message}`);
      }

      if (i < lpRounds) {
        const d = randomDelay();
        log(`   ⏳ Sleeping ${d}s…\n`);
        await sleep(d);
      }
    }

    log(`\n✅  Liquidity rounds complete.\n`);
  }

  const finalBal = await provider.getBalance(wallet.address);
  log(`🏁  Done. Final balance: ${ethers.formatEther(finalBal)} ETH`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
