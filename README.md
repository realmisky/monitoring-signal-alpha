# 🚀 Helios Trade Volume Bot — RISE Testnet

Automates swap + liquidity activity on **[Helios Trade (AsterSwap)](https://testnet.helios.trade)**, a Uniswap V2/V3-compatible DEX running on **RISE Chain Testnet**.

Generates on-chain volume to earn XP and boost airdrop eligibility.

---

## Network Info

| Property | Value |
|---|---|
| **Network** | RISE Testnet |
| **Chain ID** | `11155931` |
| **RPC** | `https://testnet.riselabs.xyz` |
| **Explorer** | `https://explorer.testnet.riselabs.xyz` |
| **Faucet** | `https://portal.risechain.com` |
| **DEX** | `https://testnet.helios.trade` |

---

## Contract Addresses

| Contract | Address |
|---|---|
| V2 Factory | `0x9f653de29013b1e92f0c9749958961c3a64e676d` |
| **V2 Router** | `0x10d48ce98bdf05be9dafa8d61f147a559c23ab85` |
| V3 Factory | `0xb79fa267550c1bc6079ee5badeaa2b2fd52a2181` |
| **V3 SwapRouter** | `0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43` |
| V3 QuoterV2 | `0x009c4554f445dfa2e757d9f0452dc7dcc444729a` |
| **Position Manager** | `0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b` |
| **WETH** | `0x4200000000000000000000000000000000000006` |
| **USDR** (USD Rise, 6 dec) | `0x04ed985f0246f00e4e9d158a70a6469e258def05` |
| WBTC (18 dec) | `0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55` |

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Get testnet ETH

Go to **https://portal.risechain.com**, enter your wallet address and drip ETH.

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set your private key — **everything else is already filled in**:

```env
PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY
```

> ⚠️ **Use a throwaway wallet. Never use a wallet with real funds.**

### 4. Run

```bash
npm run both       # swaps (V2 + V3) then add liquidity  ← recommended
npm run swap       # swaps only
npm run liquidity  # add liquidity only
```

---

## How It Works

### Swap Round (V2)
```
ETH ──[swapExactETHForTokens]──► USDR
USDR ──[swapExactTokensForETH]──► ETH
```

### Swap Round (V3)
```
ETH ──[wrap]──► WETH
WETH ──[exactInputSingle]──► USDR
USDR ──[exactInputSingle]──► WETH
WETH ──[unwrap]──► ETH
```

### Add Liquidity (V3)
```
ETH ──[wrap]──► WETH (full amount)
WETH/2 ──[exactInputSingle]──► USDR
WETH + USDR ──[positionManager.mint]──► LP NFT
```

Set `SWAP_MODE=both` to **alternate V2 and V3 swaps** each round — this hits both routers and maximises on-chain footprint for XP.

---

## 🎲 Randomization

Each round randomly picks:
- 🪙 **Token** — from `RANDOM_TOKENS` list (e.g. USDR, WBTC)
- 💰 **Amount** — between `MIN_*` and `MAX_*_AMOUNT_ETH`
- ⏱️ **Delay** — between `MIN_DELAY_SECONDS` and `MAX_DELAY_SECONDS`
- 🔀 **Engine** — V2 or V3 (50/50) when `SWAP_MODE=both`

This makes the activity look organic and harder to filter out as bot traffic.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Your testnet wallet private key |
| `RPC_URL` | `https://testnet.riselabs.xyz` | RISE testnet RPC |
| `RANDOM_TOKENS` | `USDR,WBTC` | Tokens to randomly pick from |
| `SWAP_MODE` | `both` | `v2` \| `v3` \| `both` (random per round) |
| `POOL_FEE` | `3000` | V3 fee tier: `500` / `3000` / `10000` |
| `SWAP_ROUNDS` | `10` | Number of swap cycles |
| `LIQUIDITY_ROUNDS` | `3` | Number of LP-add cycles |
| `MIN_SWAP_AMOUNT_ETH` | `0.0005` | Min random ETH per swap |
| `MAX_SWAP_AMOUNT_ETH` | `0.003` | Max random ETH per swap |
| `MIN_LP_AMOUNT_ETH` | `0.001` | Min random ETH per LP add |
| `MAX_LP_AMOUNT_ETH` | `0.005` | Max random ETH per LP add |
| `MIN_DELAY_SECONDS` | `8` | Min random wait between rounds |
| `MAX_DELAY_SECONDS` | `25` | Max random wait between rounds |
| `SLIPPAGE_PERCENT` | `5` | Slippage tolerance (%) |
| `DEADLINE_OFFSET` | `300` | Tx deadline (seconds from now) |

---

## Example Output

```
[2025-05-28T10:00:00.000Z]  🚀  Helios Trade Volume Bot  [mode=both  swapEngine=both]
[2025-05-28T10:00:00.000Z]      RPC     : https://testnet.riselabs.xyz
[2025-05-28T10:00:01.000Z]      Network : unknown (chainId=11155931)
[2025-05-28T10:00:01.000Z]      Wallet  : 0xABC...123
[2025-05-28T10:00:01.000Z]      Balance : 0.1 ETH

[2025-05-28T10:00:01.000Z]  📊  Running 10 swap rounds (0.001 ETH each | engine=both)

[2025-05-28T10:00:01.000Z]  ── [V3] Swap round 1 ──────────────────────────────
[2025-05-28T10:00:01.000Z]     ↳ Wrapping 0.001 ETH → WETH…
[2025-05-28T10:00:02.000Z]     ↳ Wrapped ✓  tx=0xabc...
[2025-05-28T10:00:02.000Z]  ▶  BUY  0.001 WETH → USDR
[2025-05-28T10:00:03.000Z]     ✅ BUY  block=123456  tx=0xdef...
[2025-05-28T10:00:06.000Z]  ▶  SELL 1.82 USDR → WETH
[2025-05-28T10:00:07.000Z]     ✅ SELL block=123458  tx=0xghi...
[2025-05-28T10:00:07.000Z]     ↳ Unwrapping 0.00099 WETH → ETH…
```

---

## Subgraph APIs

Track your volume on-chain via the AsterSwap subgraphs:

| Version | URL |
|---|---|
| V2 | `https://testnet.helios.trade/subgraphs/name/asterswap-v2-rise` |
| V3 | `https://testnet.helios.trade/subgraphs/name/asterswap-v3-rise` |

Check your XP and points:
```
https://backend-amma.onrender.com/points/<YOUR_WALLET_ADDRESS>
```

---

## Project Structure

```
monitoring-signal-alpha/
├── scripts/
│   └── volumeBot.js    # Main bot: V2 swaps, V3 swaps, V3 liquidity
├── .env.example        # Config template (contracts pre-filled)
├── .gitignore          # Keeps .env out of git
├── package.json
└── README.md
```

---

## Security

- 🔑 `.env` is gitignored — your private key never gets committed
- 🧪 Testnet wallets only
- ✅ All contract addresses sourced directly from the Helios Trade frontend
