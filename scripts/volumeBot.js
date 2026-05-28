/**
 * volumeBot.js — Helios Trade (AsterSwap) on RISE Testnet
 * ═══════════════════════════════════════════════════════════
 *  Chain     : RISE Testnet  (Chain ID 11155931)
 *  RPC       : https://testnet.riselabs.xyz
 *  Explorer  : https://explorer.testnet.riselabs.xyz
 *  DEX       : testnet.helios.trade (AsterSwap)
 *
 *  Modes:
 *    node scripts/volumeBot.js --mode swap       # V2 + V3 swaps
 *    node scripts/volumeBot.js --mode liquidity  # add V3 liquidity
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
  RPC_URL          = "https://testnet.riselabs.xyz",
  SWAP_MODE        = "v3",      // "v2" | "v3" | "both"
  POOL_FEE         = "3000",    // 500 | 3000 | 10000
  SWAP_ROUNDS      = "10",
  SWAP_AMOUNT_ETH  = "0.001",
  DELAY_SECONDS    = "12",
  SLIPPAGE_PERCENT = "5",
  DEADLINE_OFFSET  = "300",
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
  USDR:             "0x04ed985f0246f00e4e9d158a70a6469e258def05", // USD Rise (6 dec)
  WBTC:             "0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55", // Wrapped BTC (18 dec)
};

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
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
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
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] calldata data) payable returns (bytes[] memory results)",
];

const POSITION_MANAGER_ABI = [
  `function mint(
    (address token0, address token1, uint24 fee,
     int24 tickLower, int24 tickUpper,
     uint256 amount0Desired, uint256 amount1Desired,
     uint256 amount0Min, uint256 amount1Min,
     address recipient, uint256 deadline)
  ) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`,
  `function collect(
    (uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)
  ) payable returns (uint256 amount0, uint256 amount1)`,
  `function decreaseLiquidity(
    (uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
  ) payable returns (uint256 amount0, uint256 amount1)`,
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function refundETH() payable",
];

// ─── Helpers ─────────────────────────────────────────────────
const sleep   = (s) => new Promise((r) => setTimeout(r, s * 1000));
const deadline = () => Math.floor(Date.now() / 1000) + Number(DEADLINE_OFFSET);
const slippage = (amt, pct) => (amt * BigInt(100 - Number(pct))) / 100n;

function log(msg) {
  console.log(`[${new Date().toISOString()}]  ${msg}`);
}

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
// ETH → USDR → ETH  (uses V2 router, simplest path)
async function v2SwapRound(v2Router, weth, usdr, wallet, amountWei, round) {
  log(`── [V2] Swap round ${round} ──────────────────────────────`);

  const path_buy  = [CONTRACTS.WETH, CONTRACTS.USDR];
  const path_sell = [CONTRACTS.USDR, CONTRACTS.WETH];

  // ── BUY: ETH → USDR ────────────────────────────────────────
  log(`▶  BUY  ${ethers.formatEther(amountWei)} ETH → USDR`);
  const amountsOut = await v2Router.getAmountsOut(amountWei, path_buy);
  const minOut     = slippage(amountsOut[1], SLIPPAGE_PERCENT);

  const buyTx = await v2Router.swapExactETHForTokens(
    minOut, path_buy, wallet.address, deadline(), { value: amountWei }
  );
  const buyR = await buyTx.wait();
  log(`   ✅ BUY  block=${buyR.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  // ── SELL: USDR → ETH ───────────────────────────────────────
  const usdrBal = await usdr.balanceOf(wallet.address);
  if (usdrBal === 0n) { log("   ⚠️  USDR balance 0, skip sell."); return; }

  await ensureApproval(usdr, CONTRACTS.V2_ROUTER, usdrBal);

  const sellAmounts = await v2Router.getAmountsOut(usdrBal, path_sell);
  const minEthOut   = slippage(sellAmounts[1], SLIPPAGE_PERCENT);

  const usdrDec = await usdr.decimals().catch(() => 6);
  log(`▶  SELL ${ethers.formatUnits(usdrBal, usdrDec)} USDR → ETH`);

  const sellTx = await v2Router.swapExactTokensForETH(
    usdrBal, minEthOut, path_sell, wallet.address, deadline()
  );
  const sellR = await sellTx.wait();
  log(`   ✅ SELL block=${sellR.blockNumber}  tx=${sellTx.hash}`);
}

// ─── V3 SWAP ROUND ───────────────────────────────────────────
// ETH → wrap → WETH → USDR (exactInputSingle) → WETH (exactInputSingle) → unwrap → ETH
async function v3SwapRound(v3Router, v3Quoter, weth, usdr, wallet, amountWei, round) {
  log(`── [V3] Swap round ${round} ──────────────────────────────`);

  const fee = Number(POOL_FEE);

  // 1. Wrap ETH → WETH
  await wrapETH(weth, amountWei);
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, amountWei);

  // 2. BUY: WETH → USDR
  log(`▶  BUY  ${ethers.formatEther(amountWei)} WETH → USDR`);

  let quotedOut = 0n;
  try {
    quotedOut = await v3Quoter.quoteExactInputSingle.staticCall(
      CONTRACTS.WETH, CONTRACTS.USDR, fee, amountWei, 0n
    );
  } catch (_) { /* quoter optional – proceed with 0 min */ }

  const minUsdr = quotedOut > 0n ? slippage(quotedOut, SLIPPAGE_PERCENT) : 0n;

  const buyTx = await v3Router.exactInputSingle({
    tokenIn:           CONTRACTS.WETH,
    tokenOut:          CONTRACTS.USDR,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          amountWei,
    amountOutMinimum:  minUsdr,
    sqrtPriceLimitX96: 0n,
  });
  const buyR = await buyTx.wait();
  log(`   ✅ BUY  block=${buyR.blockNumber}  tx=${buyTx.hash}`);

  await sleep(3);

  // 3. SELL: USDR → WETH
  const usdrBal = await usdr.balanceOf(wallet.address);
  if (usdrBal === 0n) { log("   ⚠️  USDR balance 0, skip sell."); return; }

  await ensureApproval(usdr, CONTRACTS.V3_SWAP_ROUTER, usdrBal);

  const usdrDec = await usdr.decimals().catch(() => 6);
  log(`▶  SELL ${ethers.formatUnits(usdrBal, usdrDec)} USDR → WETH`);

  let quotedWeth = 0n;
  try {
    quotedWeth = await v3Quoter.quoteExactInputSingle.staticCall(
      CONTRACTS.USDR, CONTRACTS.WETH, fee, usdrBal, 0n
    );
  } catch (_) {}

  const minWeth = quotedWeth > 0n ? slippage(quotedWeth, SLIPPAGE_PERCENT) : 0n;

  const sellTx = await v3Router.exactInputSingle({
    tokenIn:           CONTRACTS.USDR,
    tokenOut:          CONTRACTS.WETH,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          usdrBal,
    amountOutMinimum:  minWeth,
    sqrtPriceLimitX96: 0n,
  });
  const sellR = await sellTx.wait();
  log(`   ✅ SELL block=${sellR.blockNumber}  tx=${sellTx.hash}`);

  // 4. Unwrap WETH → ETH
  const wethBal = await weth.balanceOf(wallet.address);
  if (wethBal > 0n) await unwrapWETH(weth, wethBal);
}

// ─── ADD V3 LIQUIDITY ─────────────────────────────────────────
// Wrap ETH → buy USDR with half → mint WETH/USDR LP position
async function addLiquidityV3(v3Router, posManager, v3Quoter, weth, usdr, wallet, amountWei) {
  log(`── [V3] Add Liquidity ────────────────────────────────────`);

  const fee     = Number(POOL_FEE);
  const halfEth = amountWei / 2n;

  // 1. Wrap all ETH
  await wrapETH(weth, amountWei);

  // 2. Buy USDR with half the WETH
  await ensureApproval(weth, CONTRACTS.V3_SWAP_ROUTER, halfEth);
  log(`▶  Buying USDR with ${ethers.formatEther(halfEth)} WETH…`);

  const buyTx = await v3Router.exactInputSingle({
    tokenIn:           CONTRACTS.WETH,
    tokenOut:          CONTRACTS.USDR,
    fee,
    recipient:         wallet.address,
    deadline:          deadline(),
    amountIn:          halfEth,
    amountOutMinimum:  0n,
    sqrtPriceLimitX96: 0n,
  });
  await buyTx.wait();
  log(`   ✅ Buy tx=${buyTx.hash}`);

  const usdrBal = await usdr.balanceOf(wallet.address);
  const wethBal = await weth.balanceOf(wallet.address);

  if (usdrBal === 0n || wethBal === 0n) {
    log("   ⚠️  Insufficient balances for LP. Skipping.");
    return;
  }

  // 3. Approve both tokens for position manager
  await ensureApproval(weth, CONTRACTS.POSITION_MANAGER, wethBal);
  await ensureApproval(usdr, CONTRACTS.POSITION_MANAGER, usdrBal);

  // 4. Sort token order (V3 requires token0 < token1 by address)
  const wethLower = CONTRACTS.WETH.toLowerCase() < CONTRACTS.USDR.toLowerCase();
  const [token0, token1, amt0, amt1] = wethLower
    ? [CONTRACTS.WETH, CONTRACTS.USDR, wethBal, usdrBal]
    : [CONTRACTS.USDR, CONTRACTS.WETH, usdrBal, wethBal];

  // 5. Tick range — full range (max) for testnet simplicity
  //    tick spacing for 0.3% fee = 60 → nearest valid multiple of 60 ≤ 887220
  const TICK_LOWER = -887220;
  const TICK_UPPER =  887220;

  const usdrDec = await usdr.decimals().catch(() => 6);
  log(`▶  Minting LP: ${ethers.formatEther(wethBal)} WETH + ${ethers.formatUnits(usdrBal, usdrDec)} USDR`);

  const mintTx = await posManager.mint({
    token0,
    token1,
    fee,
    tickLower:       TICK_LOWER,
    tickUpper:       TICK_UPPER,
    amount0Desired:  amt0,
    amount1Desired:  amt1,
    amount0Min:      slippage(amt0, SLIPPAGE_PERCENT),
    amount1Min:      slippage(amt1, SLIPPAGE_PERCENT),
    recipient:       wallet.address,
    deadline:        deadline(),
  });
  const mintR = await mintTx.wait();
  log(`   ✅ LP minted  block=${mintR.blockNumber}  tx=${mintTx.hash}`);
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  log(`🚀  Helios Trade Volume Bot  [mode=${MODE}  swapEngine=${SWAP_MODE}]`);
  log(`    RPC     : ${RPC_URL}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();
  const balance  = await provider.getBalance(wallet.address);

  log(`    Network : ${network.name} (chainId=${network.chainId})`);
  log(`    Wallet  : ${wallet.address}`);
  log(`    Balance : ${ethers.formatEther(balance)} ETH`);

  if (network.chainId !== 11155931n) {
    log(`    ⚠️  Expected RISE Testnet (11155931), got ${network.chainId}`);
  }

  // ── Contract instances ───────────────────────────────────
  const v2Router   = new ethers.Contract(CONTRACTS.V2_ROUTER,        V2_ROUTER_ABI,          wallet);
  const v3Router   = new ethers.Contract(CONTRACTS.V3_SWAP_ROUTER,   V3_ROUTER_ABI,          wallet);
  const v3Quoter   = new ethers.Contract(CONTRACTS.V3_QUOTER,        V3_QUOTER_ABI,          wallet);
  const posManager = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI,   wallet);
  const weth       = new ethers.Contract(CONTRACTS.WETH,             WETH_ABI,               wallet);
  const usdr       = new ethers.Contract(CONTRACTS.USDR,             ERC20_ABI,              wallet);

  const swapWei  = ethers.parseEther(SWAP_AMOUNT_ETH);
  const rounds   = Number(SWAP_ROUNDS);
  const delaySec = Number(DELAY_SECONDS);

  // ── SWAP ROUNDS ──────────────────────────────────────────
  if (MODE === "swap" || MODE === "both") {
    log(`\n📊  Running ${rounds} swap rounds (${SWAP_AMOUNT_ETH} ETH each | engine=${SWAP_MODE})\n`);

    for (let i = 1; i <= rounds; i++) {
      try {
        if (SWAP_MODE === "v2") {
          await v2SwapRound(v2Router, weth, usdr, wallet, swapWei, i);
        } else if (SWAP_MODE === "v3") {
          await v3SwapRound(v3Router, v3Quoter, weth, usdr, wallet, swapWei, i);
        } else {
          // "both" — alternate V2 and V3 each round for max coverage
          if (i % 2 === 0) {
            await v2SwapRound(v2Router, weth, usdr, wallet, swapWei, i);
          } else {
            await v3SwapRound(v3Router, v3Quoter, weth, usdr, wallet, swapWei, i);
          }
        }
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
    log(`\n💧  Adding V3 liquidity (${SWAP_AMOUNT_ETH} ETH)\n`);
    try {
      await addLiquidityV3(v3Router, posManager, v3Quoter, weth, usdr, wallet, swapWei);
    } catch (err) {
      log(`   ❌ Liquidity failed: ${err.shortMessage ?? err.message}`);
    }
    log(`\n✅  Liquidity round complete.\n`);
  }

  // ── Final balance ────────────────────────────────────────
  const finalBal = await provider.getBalance(wallet.address);
  log(`🏁  Done. Final balance: ${ethers.formatEther(finalBal)} ETH`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
