# 🧠 Helios Trade Smart Volume Bot — RISE Testnet

Automates randomized swap + liquidity activity on **[Helios Trade (AsterSwap)](https://testnet.helios.trade)** with a built-in **Smart Analyst** that decides each round's action based on real-time market data.

---

## 🤖 Smart Analyst

Every round, the analyst:

1. **Quotes both V2 and V3 routers** for every candidate token
2. **Calculates the price spread** between V2 and V3 (in basis points)
3. **Scores each option** based on liquidity depth, recent activity, and arb potential
4. **Decides the best action**:
   - 🎯 **Arbitrage swap** — if spread ≥ `ARB_THRESHOLD_BPS` (capture PnL)
   - 💧 **Add liquidity** — after `SWAP_TO_LP_RATIO` swaps (rebalance + earn fees)
   - 📊 **Standard volume swap** — default fallback (rack up XP)
5. **Picks the optimal engine** (V2 or V3) based on which gives a better quote
6. **Tracks PnL and volume** across all rounds and prints a final report

### Decision flow

```
                    ┌──────────────────────┐
                    │  Quote V2 + V3       │
                    │  for all tokens      │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Spread ≥ threshold? │
                    └──────┬───────┬───────┘
                       Yes │       │ No
                           ▼       ▼
                  ┌─────────────┐  ┌─────────────────────┐
                  │ ARB SWAP    │  │ Recent swaps ≥ N?    │
                  │ (best engine│  └────┬────────┬────────┘
                  │  + token)   │   Yes │        │ No
                  └─────────────┘       ▼        ▼
                                  ┌──────────┐ ┌──────────┐
                                  │ ADD LP   │ │  SWAP    │
                                  │ (rebal.) │ │ (volume) │
                                  └──────────┘ └──────────┘
```

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
| V2 Router | `0x10d48ce98bdf05be9dafa8d61f147a559c23ab85` |
| V3 SwapRouter | `0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43` |
| V3 QuoterV2 | `0x009c4554f445dfa2e757d9f0452dc7dcc444729a` |
| Position Manager | `0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b` |
| WETH | `0x4200000000000000000000000000000000000006` |
| USDR (6 dec) | `0x04ed985f0246f00e4e9d158a70a6469e258def05` |
| WBTC (18 dec) | `0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55` |

---

## Quick Start

```bash
npm install
cp .env.example .env   # add your PRIVATE_KEY
npm start              # runs analyst-driven mode (recommended)
```

### Modes

```bash
npm run auto       # 🧠 smart analyst decides each round (default)
npm run swap       # force every round to be a swap
npm run liquidity  # force every round to be an LP add
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Your testnet wallet private key |
| `RPC_URL` | `https://testnet.riselabs.xyz` | RISE testnet RPC |
| `RANDOM_TOKENS` | `USDR,WBTC` | Tokens to randomly pick from |
| `POOL_FEE` | `3000` | V3 fee tier: `500` / `3000` / `10000` |
| `ARB_THRESHOLD_BPS` | `50` | Min spread (bps) to trigger arb swap |
| `SWAP_TO_LP_RATIO` | `4` | Force LP add after N swaps in a row |
| `TOTAL_ROUNDS` | `15` | Total rounds for analyst mode |
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
[2025-05-28T10:00:00.000Z]  🚀  Helios Smart Volume Bot  [mode=auto]
[2025-05-28T10:00:00.000Z]      Tokens       : USDR, WBTC
[2025-05-28T10:00:00.000Z]      Arb threshold: 50 bps
[2025-05-28T10:00:00.000Z]      Swap:LP ratio: 4:1

╭─── Round 1/15 ──────────────────────────
│  📊 Decision : SWAP via V3
│  🪙 Token    : WBTC
│  💰 Amount   : 0.001873 ETH
│  💡 Reason   : arb opportunity 78bps on WBTC
│  📈 Spread   : 78 bps  (V2=2891234, V3=2913456)
│  ⭐ Score    : 128
╰──────────────────────────────────────────────────

╭─── Round 5/15 ──────────────────────────
│  📊 Decision : LP
│  🪙 Token    : USDR
│  💰 Amount   : 0.003120 ETH
│  💡 Reason   : 4 consecutive swaps → rebalance with LP
│  📈 Spread   : 12 bps
│  ⭐ Score    : 65
╰──────────────────────────────────────────────────

…

╔══════════════════════════════════════════════════════╗
║              SMART ANALYST REPORT                    ║
╠══════════════════════════════════════════════════════╣
║  Total swaps        : 12                             ║
║  Total LP adds      : 3                              ║
║  Arbs taken         : 2                              ║
║  Total volume       : 0.027450 ETH                   ║
║  Estimated PnL      : -0.000180 ETH                  ║
╠══════════════════════════════════════════════════════╣
║  Per-token breakdown:                                ║
║    USDR    swaps=6   lps=2   vol=0.014230            ║
║    WBTC    swaps=6   lps=1   vol=0.013220            ║
╚══════════════════════════════════════════════════════╝
```

---

## Project Structure

```
monitoring-signal-alpha/
├── scripts/
│   ├── volumeBot.js   # Main runner — orchestrates rounds
│   └── analyst.js     # Smart Analyst — decides swap vs LP, picks engine/token
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Subgraph & Points API

Track your activity via Helios subgraphs:
- V2: `https://testnet.helios.trade/subgraphs/name/asterswap-v2-rise`
- V3: `https://testnet.helios.trade/subgraphs/name/asterswap-v3-rise`

Check your XP:
```
https://backend-amma.onrender.com/points/<YOUR_WALLET_ADDRESS>
```
