/**
 * volumeBot.js
 * ─────────────────────────────────────────────────────────────
 * Testnet volume bot: swap tokens + add liquidity on any
 * Uniswap V2-compatible DEX (Uniswap, Sushiswap, Quickswap…)
 *
 * Usage:
 *   node scripts/volumeBot.js --mode swap       # swaps only
 *   node scripts/volumeBot.js --mode liquidity  # add liquidity only
 *   node scripts/volumeBot.js --mode both       # swaps then liquidity
 * ─────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { ethers } from "ethers";

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const modeArg = args.indexOf("--mode");
const MODE = modeArg !== -1 ? args[modeArg + 1] : "both";

// ─── Config from .env ────────────────────────────────────────
const {
  PRIVATE_KEY,
  RPC_URL,
  ROUTER_ADDRESS,
  TOKEN_A,
  TOKEN_B,
  SWAP_ROUNDS       = "10",
  SWAP_AMOUNT_ETH   = "0.001",
  DELAY_SECONDS     = "15",
  SLIPPAGE_PERCENT  = "5",
  DEADLINE_OFFSET   = "300",
} = process.env;

if (!PRIVATE_KEY || !RPC_URL || !ROUTER_ADDRESS || !TOKEN_A || !TOKEN_B) {
  console.error("❌  Missing required env vars. Copy .env.example → .env and fill in values.");
  process.exit(1);
}

// ─── ABI snippets ────────────────────────────────────────────
const ROUTER_ABI = [
  // swapExactETHForTokens
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
  // swapExactTokensForETH
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  // swapExactTokensForTokens
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  // addLiquidityETH
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)",
  // addLiquidity (token/token pair)
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)",
  // getAmountsOut
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  // WETH address
  "function WETH() view returns (address)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ─── Helpers ─────────────────────────────────────────────────
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function deadline() {
  return Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
}

function withSlippage(amount, slipPct) {
  return (amount * BigInt(100 - Number(slipPct))) / 100n;
}

async function ensureApproval(token, spender, amount, signer) {
  const allowance = await token.allowance(signer.address, spender);
  if (allowance < amount) {
    console.log(`   ↳ Approving ${await token.symbol()}…`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    console.log(`   ↳ Approved ✓  (tx: ${tx.hash})`);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Core actions ────────────────────────────────────────────

/**
 * Swap ETH → Token B, then Token B → ETH  (one round)
 */
async function runSwapRound(router, tokenB, wallet, swapAmountWei, roundNum) {
  log(`── Swap round ${roundNum} ──────────────────────────`);
  const weth = await router.WETH();
  const pathBuy  = [weth, TOKEN_B];
  const pathSell = [TOKEN_B, weth];

  // ── BUY: ETH → Token B ──────────────────────────────────
  log(`▶  BUY  ${ethers.formatEther(swapAmountWei)} ETH → ${await tokenB.symbol()}`);

  const amountsOut = await router.getAmountsOut(swapAmountWei, pathBuy);
  const minOut = withSlippage(amountsOut[1], SLIPPAGE_PERCENT);

  const buyTx = await router.swapExactETHForTokens(
    minOut,
    pathBuy,
    wallet.address,
    deadline(),
    { value: swapAmountWei }
  );
  const buyReceipt = await buyTx.wait();
  log(`   ✅ BUY confirmed  block=${buyReceipt.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3); // brief pause between buy/sell

  // ── SELL: Token B → ETH ─────────────────────────────────
  const tokenBalance = await tokenB.balanceOf(wallet.address);
  if (tokenBalance === 0n) {
    log("   ⚠️  Token balance is 0, skipping sell.");
    return;
  }

  await ensureApproval(tokenB, ROUTER_ADDRESS, tokenBalance, wallet);

  const sellAmountsOut = await router.getAmountsOut(tokenBalance, pathSell);
  const minEthOut = withSlippage(sellAmountsOut[1], SLIPPAGE_PERCENT);

  log(`▶  SELL ${ethers.formatUnits(tokenBalance, await tokenB.decimals())} ${await tokenB.symbol()} → ETH`);

  const sellTx = await router.swapExactTokensForETH(
    tokenBalance,
    minEthOut,
    pathSell,
    wallet.address,
    deadline()
  );
  const sellReceipt = await sellTx.wait();
  log(`   ✅ SELL confirmed  block=${sellReceipt.blockNumber}  tx=${sellTx.hash}`);
}

/**
 * Add liquidity: ETH + Token B
 */
async function addLiquidityRound(router, tokenB, wallet, ethAmountWei) {
  log(`── Add Liquidity ──────────────────────────────────`);

  const weth    = await router.WETH();
  const pathBuy = [weth, TOKEN_B];

  // Get expected token amount for half the ETH
  const halfEth = ethAmountWei / 2n;
  const amountsOut = await router.getAmountsOut(halfEth, pathBuy);
  const tokenAmountDesired = amountsOut[1];

  const tokenAmountMin = withSlippage(tokenAmountDesired, SLIPPAGE_PERCENT);
  const ethAmountMin   = withSlippage(halfEth, SLIPPAGE_PERCENT);

  // First buy tokens with half the ETH so we have a matching token balance
  log(`▶  Buying tokens with ${ethers.formatEther(halfEth)} ETH for liquidity…`);
  const buyTx = await router.swapExactETHForTokens(
    tokenAmountMin,
    pathBuy,
    wallet.address,
    deadline(),
    { value: halfEth }
  );
  await buyTx.wait();
  log(`   ✅ Token buy confirmed  tx=${buyTx.hash}`);

  const tokenBalance = await tokenB.balanceOf(wallet.address);
  await ensureApproval(tokenB, ROUTER_ADDRESS, tokenBalance, wallet);

  log(`▶  Adding liquidity: ${ethers.formatEther(halfEth)} ETH + ${ethers.formatUnits(tokenBalance, await tokenB.decimals())} ${await tokenB.symbol()}`);

  const addTx = await router.addLiquidityETH(
    TOKEN_B,
    tokenBalance,
    tokenAmountMin,
    ethAmountMin,
    wallet.address,
    deadline(),
    { value: halfEth }
  );
  const addReceipt = await addTx.wait();
  log(`   ✅ Liquidity added  block=${addReceipt.blockNumber}  tx=${addTx.hash}`);
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  log(`🚀  Volume Bot starting  [mode=${MODE}]`);
  log(`    Wallet  : loading…`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);

  log(`    Network : ${network.name} (chainId=${network.chainId})`);
  log(`    Address : ${wallet.address}`);
  log(`    Balance : ${ethers.formatEther(balance)} ETH`);

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const tokenB = new ethers.Contract(TOKEN_B, ERC20_ABI, wallet);

  const swapAmountWei = ethers.parseEther(SWAP_AMOUNT_ETH);
  const rounds        = Number(SWAP_ROUNDS);
  const delaySec      = Number(DELAY_SECONDS);

  // ── SWAP rounds ─────────────────────────────────────────
  if (MODE === "swap" || MODE === "both") {
    log(`\n📊  Running ${rounds} swap rounds  (${SWAP_AMOUNT_ETH} ETH each)\n`);
    for (let i = 1; i <= rounds; i++) {
      try {
        await runSwapRound(router, tokenB, wallet, swapAmountWei, i);
      } catch (err) {
        log(`   ❌ Round ${i} failed: ${err.message}`);
      }
      if (i < rounds) {
        log(`   ⏳ Waiting ${delaySec}s before next round…`);
        await sleep(delaySec);
      }
    }
    log(`\n✅  Swap rounds complete.\n`);
  }

  // ── ADD LIQUIDITY ────────────────────────────────────────
  if (MODE === "liquidity" || MODE === "both") {
    log(`\n💧  Adding liquidity  (${SWAP_AMOUNT_ETH} ETH total)\n`);
    try {
      await addLiquidityRound(router, tokenB, wallet, swapAmountWei);
    } catch (err) {
      log(`   ❌ Add liquidity failed: ${err.message}`);
    }
    log(`\n✅  Liquidity round complete.\n`);
  }

  log(`🏁  Bot finished.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
