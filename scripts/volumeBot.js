/**
 * volumeBot.js — RISE Chain Testnet (helios.trade)
 * ─────────────────────────────────────────────────────────────
 * Generates testnet volume on Helios Trade (testnet.helios.trade)
 * by running swap rounds + adding liquidity on the RISE testnet.
 *
 * Chain  : RISE Testnet (Chain ID 11155931)
 * RPC    : https://testnet.riselabs.xyz
 * DEX    : Helios Trade — Uniswap V3-compatible
 *
 * Modes:
 *   node scripts/volumeBot.js --mode swap        # ETH ⇄ token swaps
 *   node scripts/volumeBot.js --mode liquidity   # add liquidity
 *   node scripts/volumeBot.js --mode both        # swaps then liquidity
 * ─────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { ethers } from "ethers";

// ─── CLI args ────────────────────────────────────────────────
const args   = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const MODE   = modeIdx !== -1 ? args[modeIdx + 1] : "both";

// ─── Config from .env ────────────────────────────────────────
const {
  PRIVATE_KEY,
  RPC_URL             = "https://testnet.riselabs.xyz",
  SWAP_ROUTER         ,   // Helios V3 SwapRouter address
  POSITION_MANAGER    ,   // Helios V3 NonfungiblePositionManager address
  WETH_ADDRESS        ,   // WETH on RISE testnet
  TOKEN_ADDRESS       ,   // Token to trade (USDC, USDT, etc.)
  POOL_FEE            = "3000",   // 0.3% = 3000 | 0.05% = 500 | 1% = 10000
  SWAP_ROUNDS         = "10",
  SWAP_AMOUNT_ETH     = "0.001",
  DELAY_SECONDS       = "12",
  SLIPPAGE_PERCENT    = "5",
  DEADLINE_OFFSET     = "300",
} = process.env;

// ─── Validate required config ────────────────────────────────
const required = { PRIVATE_KEY, SWAP_ROUTER, POSITION_MANAGER, WETH_ADDRESS, TOKEN_ADDRESS };
const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(", ")}`);
  console.error("    Copy .env.example → .env and fill in the values.");
  process.exit(1);
}

// ─── Uniswap V3 ABI snippets ─────────────────────────────────
const SWAP_ROUTER_ABI = [
  // exactInputSingle: swap exact tokenIn → tokenOut
  `function exactInputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient,
     uint256 deadline, uint256 amountIn, uint256 amountOutMinimum,
     uint160 sqrtPriceLimitX96) params
  ) payable returns (uint256 amountOut)`,

  // exactOutputSingle: receive exact tokenOut, spend up to amountInMaximum
  `function exactOutputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient,
     uint256 deadline, uint256 amountOut, uint256 amountInMaximum,
     uint160 sqrtPriceLimitX96) params
  ) payable returns (uint256 amountIn)`,

  // refundETH: recover unused ETH from router
  "function refundETH() payable",
];

const POSITION_MANAGER_ABI = [
  // mint: create a new position (add liquidity)
  `function mint(
    (address token0, address token1, uint24 fee, int24 tickLower,
     int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired,
     uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)
  ) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`,

  // refundETH
  "function refundETH() payable",
];

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

// ─── Helpers ─────────────────────────────────────────────────
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function getDeadline() {
  return Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
}

function applySlippage(amount, pct) {
  return (amount * BigInt(100 - Number(pct))) / 100n;
}

async function ensureApproval(token, spender, amount, label) {
  const allowance = await token.allowance(await token.runner.getAddress(), spender);
  if (allowance < amount) {
    const sym = await token.symbol().catch(() => label);
    log(`   ↳ Approving ${sym} for ${spender.slice(0, 10)}…`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log(`   ↳ Approved ✓  (tx: ${tx.hash})`);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}]  ${msg}`);
}

// ─── WRAP ETH → WETH ─────────────────────────────────────────
async function wrapEth(weth, amountWei) {
  log(`   ↳ Wrapping ${ethers.formatEther(amountWei)} ETH → WETH…`);
  const tx = await weth.deposit({ value: amountWei });
  await tx.wait();
  log(`   ↳ Wrapped ✓  (tx: ${tx.hash})`);
}

// ─── SWAP ROUND: WETH → TOKEN → WETH ─────────────────────────
async function runSwapRound(swapRouter, weth, token, wallet, swapWei, round) {
  log(`── Swap round ${round} ──────────────────────────────────`);

  const fee        = Number(POOL_FEE);
  const wethAddr   = await weth.getAddress();
  const tokenAddr  = await token.getAddress();
  const tokenSym   = await token.symbol().catch(() => "TOKEN");

  // ── Step 1: Wrap ETH ───────────────────────────────────────
  await wrapEth(weth, swapWei);

  // ── Step 2: Approve WETH for router ───────────────────────
  await ensureApproval(weth, SWAP_ROUTER, swapWei, "WETH");

  // ── Step 3: BUY  WETH → TOKEN ─────────────────────────────
  log(`▶  BUY  ${ethers.formatEther(swapWei)} WETH → ${tokenSym}`);
  const buyTx = await swapRouter.exactInputSingle({
    tokenIn            : wethAddr,
    tokenOut           : tokenAddr,
    fee,
    recipient          : wallet.address,
    deadline           : getDeadline(),
    amountIn           : swapWei,
    amountOutMinimum   : 0n,          // accept any amount (testnet, not real money)
    sqrtPriceLimitX96  : 0n,
  });
  const buyReceipt = await buyTx.wait();
  log(`   ✅ BUY  confirmed  block=${buyReceipt.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  // ── Step 4: Check token balance ───────────────────────────
  const tokenBalance = await token.balanceOf(wallet.address);
  if (tokenBalance === 0n) {
    log(`   ⚠️  Token balance is 0 after buy — skipping sell.`);
    return;
  }

  // ── Step 5: Approve TOKEN for router ──────────────────────
  await ensureApproval(token, SWAP_ROUTER, tokenBalance, tokenSym);

  // ── Step 6: SELL  TOKEN → WETH ────────────────────────────
  const tokenDecimals = await token.decimals().catch(() => 18);
  log(`▶  SELL ${ethers.formatUnits(tokenBalance, tokenDecimals)} ${tokenSym} → WETH`);
  const sellTx = await swapRouter.exactInputSingle({
    tokenIn            : tokenAddr,
    tokenOut           : wethAddr,
    fee,
    recipient          : wallet.address,
    deadline           : getDeadline(),
    amountIn           : tokenBalance,
    amountOutMinimum   : 0n,
    sqrtPriceLimitX96  : 0n,
  });
  const sellReceipt = await sellTx.wait();
  log(`   ✅ SELL confirmed  block=${sellReceipt.blockNumber}  tx=${sellTx.hash}`);

  // ── Step 7: Unwrap WETH back to ETH ───────────────────────
  const wethBalance = await weth.balanceOf(wallet.address);
  if (wethBalance > 0n) {
    log(`   ↳ Unwrapping ${ethers.formatEther(wethBalance)} WETH → ETH…`);
    const unwrapTx = await weth.withdraw(wethBalance);
    await unwrapTx.wait();
    log(`   ↳ Unwrapped ✓  (tx: ${unwrapTx.hash})`);
  }
}

// ─── ADD LIQUIDITY ────────────────────────────────────────────
async function addLiquidityRound(swapRouter, posManager, weth, token, wallet, ethAmountWei) {
  log(`── Add Liquidity ────────────────────────────────────────`);

  const fee       = Number(POOL_FEE);
  const wethAddr  = await weth.getAddress();
  const tokenAddr = await token.getAddress();
  const tokenSym  = await token.symbol().catch(() => "TOKEN");

  // Use half ETH to buy tokens, pair the other half as WETH in the pool
  const halfEth = ethAmountWei / 2n;

  // Wrap all ETH first
  await wrapEth(weth, ethAmountWei);
  await ensureApproval(weth, SWAP_ROUTER, halfEth, "WETH");

  // Buy token with half the WETH
  log(`▶  Buying ${tokenSym} with ${ethers.formatEther(halfEth)} WETH…`);
  const buyTx = await swapRouter.exactInputSingle({
    tokenIn           : wethAddr,
    tokenOut          : tokenAddr,
    fee,
    recipient         : wallet.address,
    deadline          : getDeadline(),
    amountIn          : halfEth,
    amountOutMinimum  : 0n,
    sqrtPriceLimitX96 : 0n,
  });
  await buyTx.wait();
  log(`   ✅ Buy confirmed  tx=${buyTx.hash}`);

  const tokenBalance = await token.balanceOf(wallet.address);
  const wethBalance  = await weth.balanceOf(wallet.address);

  if (tokenBalance === 0n || wethBalance === 0n) {
    log("   ⚠️  Insufficient token or WETH balance for liquidity — skipping.");
    return;
  }

  // Approve both tokens for positionManager
  await ensureApproval(weth,  POSITION_MANAGER, wethBalance,  "WETH");
  await ensureApproval(token, POSITION_MANAGER, tokenBalance, tokenSym);

  // Sort token addresses (V3 requires token0 < token1)
  const [token0, token1, amount0, amount1] =
    wethAddr.toLowerCase() < tokenAddr.toLowerCase()
      ? [wethAddr,  tokenAddr,  wethBalance,  tokenBalance]
      : [tokenAddr, wethAddr,   tokenBalance, wethBalance];

  // Wide tick range — covers most realistic price scenarios on testnet
  // tick spacing for 0.3% = 60 → use ±887220 (max range)
  const TICK_LOWER = -887220;
  const TICK_UPPER =  887220;

  log(`▶  Adding liquidity: ${ethers.formatEther(wethBalance)} WETH + ${ethers.formatUnits(tokenBalance, await token.decimals().catch(() => 18))} ${tokenSym}`);

  const mintTx = await posManager.mint({
    token0,
    token1,
    fee,
    tickLower        : TICK_LOWER,
    tickUpper        : TICK_UPPER,
    amount0Desired   : amount0,
    amount1Desired   : amount1,
    amount0Min       : applySlippage(amount0, SLIPPAGE_PERCENT),
    amount1Min       : applySlippage(amount1, SLIPPAGE_PERCENT),
    recipient        : wallet.address,
    deadline         : getDeadline(),
  });
  const mintReceipt = await mintTx.wait();
  log(`   ✅ Liquidity added  block=${mintReceipt.blockNumber}  tx=${mintTx.hash}`);
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  log(`🚀  Helios Trade Volume Bot  [mode=${MODE}]`);
  log(`    RPC     : ${RPC_URL}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);

  log(`    Network : ${network.name} (chainId=${network.chainId})`);
  log(`    Address : ${wallet.address}`);
  log(`    Balance : ${ethers.formatEther(balance)} ETH`);

  if (network.chainId !== 11155931n) {
    log(`    ⚠️  Warning: expected RISE Testnet (11155931), got ${network.chainId}`);
  }

  // Contract instances
  const swapRouter  = new ethers.Contract(SWAP_ROUTER,      SWAP_ROUTER_ABI,      wallet);
  const posManager  = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
  const weth        = new ethers.Contract(WETH_ADDRESS,     WETH_ABI,             wallet);
  const token       = new ethers.Contract(TOKEN_ADDRESS,    ERC20_ABI,            wallet);

  const swapWei  = ethers.parseEther(SWAP_AMOUNT_ETH);
  const rounds   = Number(SWAP_ROUNDS);
  const delaySec = Number(DELAY_SECONDS);

  // ── SWAP ROUNDS ──────────────────────────────────────────
  if (MODE === "swap" || MODE === "both") {
    log(`\n📊  Running ${rounds} swap rounds  (${SWAP_AMOUNT_ETH} ETH each)\n`);
    for (let i = 1; i <= rounds; i++) {
      try {
        await runSwapRound(swapRouter, weth, token, wallet, swapWei, i);
      } catch (err) {
        log(`   ❌ Round ${i} failed: ${err.shortMessage ?? err.message}`);
      }
      if (i < rounds) {
        log(`   ⏳ Waiting ${delaySec}s…\n`);
        await sleep(delaySec);
      }
    }
    log(`\n✅  Swap rounds complete.\n`);
  }

  // ── ADD LIQUIDITY ────────────────────────────────────────
  if (MODE === "liquidity" || MODE === "both") {
    log(`\n💧  Adding liquidity  (${SWAP_AMOUNT_ETH} ETH)\n`);
    try {
      await addLiquidityRound(swapRouter, posManager, weth, token, wallet, swapWei);
    } catch (err) {
      log(`   ❌ Add liquidity failed: ${err.shortMessage ?? err.message}`);
    }
    log(`\n✅  Liquidity round complete.\n`);
  }

  log(`🏁  Done.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
