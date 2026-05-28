# 🧠 Helios Trade Smart Volume Bot v3 — RISE Testnet

A volume bot for **[Helios Trade (AsterSwap)](https://testnet.helios.trade)** with a real **Smart Analyst**: live pool data, gas-aware PnL, price impact estimation, and stop-loss risk controls.

---

## ✨ What's new in v3

| Feature | What it does |
|---|---|
| 🔴 **Live market data** | On-chain V2 reserves + V3 liquidity + subgraph 24h volume per round |
| 💥 **Price impact estimation** | Compares quote-vs-spot via `QuoterV2`, returns bps of slippage |
| 📐 **Volume-weighted sizing** | Auto-halves trade size if impact exceeds `MAX_PRICE_IMPACT_BPS` |
| ⛽ **Real gas tracking** | Captures `gasUsed × gasPrice` from every receipt, deducts from PnL |
| 💰 **True PnL accounting** | Round-trip = `ethOut − ethIn − totalGas` (gas-adjusted) |
| 📝 **Per-trade JSON log** | Writes every trade to `trade-log.json` with all metrics |
| 🛑 **Stop-loss** | Halts when session loss > `STOP_LOSS_PCT` of starting balance |
| 🪙 **Min-balance guard** | Skips rounds when balance falls below `MIN_BALANCE_ETH` |
| 📊 **Subgraph signal** | Bonuses tokens with high recent on-chain volume |

---

## 🧠 Decision flow

```
                ┌─────────────────────────────────────┐
                │ For each token:                     │
                │   • Get V2 reserves + V3 liquidity  │
                │   • Pull subgraph 24h volume        │
                │   • Quote V2 + V3 for spread (bps)  │
                │   • Score swap & LP options         │
                └──────────────┬──────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Spread ≥ threshold? │ → ARB SWAP (best engine)
                    └──────┬───────────────┘
                           ▼
                    ┌──────────────────────┐
                    │  Consec swaps ≥ N?   │ → ADD LIQUIDITY
                    └──────┬───────────────┘
                           ▼
                       VOLUME SWAP
                           │
                           ▼
                ┌─────────────────────────────────────┐
                │ Volume-weighted sizing:             │
                │   Estimate price impact, halve      │
                │   trade until impact ≤ cap          │
                └──────────────┬──────────────────────┘
                               ▼
                ┌─────────────────────────────────────┐
                │ Execute + track:                    │
                │   • gas cost per leg                │
                │   • slippage (expected vs actual)   │
                │   • round-trip PnL                  │
                │   • write to trade-log.json         │
                └──────────────┬──────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Stop-loss exceeded? │ → HALT
                    └──────────────────────┘
```

---

## 🏗️ Architecture

```
scripts/
├── volumeBot.js      ← Orchestrator (main loop, risk checks)
├── analyst.js        ← Decision engine (scores swap vs LP, picks token & engine)
├── marketData.js     ← Live data feed (V2/V3 pools, subgraph, price impact)
└── pnlTracker.js     ← Real PnL accounting (gas, slippage, JSON log)
```

---

## Network Info

| Property | Value |
|---|---|
| **Network** | RISE Testnet |
| **Chain ID** | `11155931` |
| **RPC** | `https://testnet.riselabs.xyz` |
| **Explorer** | `https://explorer.testnet.riselabs.xyz` |
| **DEX** | `https://testnet.helios.trade` |
| **V2 Subgraph** | `https://testnet.helios.trade/subgraphs/name/asterswap-v2-rise` |
| **V3 Subgraph** | `https://testnet.helios.trade/subgraphs/name/asterswap-v3-rise` |

---

## Quick Start

```bash
npm install
cp .env.example .env   # add your PRIVATE_KEY
npm start              # smart analyst (auto mode)
```

Modes:
```bash
npm start          # 🧠 auto — analyst decides each round (default)
npm run swap       # force every round to be a swap
npm run liquidity  # force every round to be an LP add
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Testnet wallet key |
| `RPC_URL` | `https://testnet.riselabs.xyz` | RISE testnet RPC |
| `RANDOM_TOKENS` | `USDR,WBTC` | Tokens the analyst can pick from |
| `POOL_FEE` | `3000` | V3 fee tier (500/3000/10000) |
| `TOTAL_ROUNDS` | `15` | How many rounds to run |
| `ARB_THRESHOLD_BPS` | `50` | Spread (bps) that triggers an arb swap |
| `MAX_PRICE_IMPACT_BPS` | `100` | Cap V3 trade size if impact > this |
| `SWAP_TO_LP_RATIO` | `4` | Force LP add after N consecutive swaps |
| `STOP_LOSS_PCT` | `5` | Halt if session loss > X% of start balance |
| `MIN_BALANCE_ETH` | `0.005` | Skip if balance < this |
| `MIN_SWAP_AMOUNT_ETH` | `0.0005` | Min random swap amount |
| `MAX_SWAP_AMOUNT_ETH` | `0.003` | Max random swap amount |
| `MIN_LP_AMOUNT_ETH` | `0.001` | Min random LP amount |
| `MAX_LP_AMOUNT_ETH` | `0.005` | Max random LP amount |
| `MIN_DELAY_SECONDS` | `8` | Min random wait between rounds |
| `MAX_DELAY_SECONDS` | `25` | Max random wait between rounds |
| `SLIPPAGE_PERCENT` | `5` | Slippage tolerance |
| `DEADLINE_OFFSET` | `300` | Tx deadline (seconds) |
| `TRADE_LOG_PATH` | `./trade-log.json` | Where to write trade log |

---

## 📊 Sample output

```
╭─── Round 3/15 ──────────────────────────
│  📊 Decision     : SWAP via V3
│  🪙 Token        : WBTC
│  💰 Amount       : 0.001234 ETH
│  💡 Reason       : arb spread 78bps on WBTC
│  📈 Spread       : 78 bps
│  💥 Impact       : 23 bps
│  💧 V3 liquidity : 1234567890123456789
│  📊 Subgraph vol : $4521.30 (38 txs)
│  ⭐ Score        : 142
╰──────────────────────────────────────────

   ↳ Wrapped 0.001234 ETH → WETH  tx=0xabc…
▶  [V3] BUY  0.001234 WETH → WBTC
   📝 BUY v3 WBTC | gas=0.00001423 ETH | impact=23bps | slip=4bps
▶  [V3] SELL 0.000000234 WBTC → WETH
   📝 SELL v3 WBTC | gas=0.00001498 ETH | impact=?bps | slip=2bps
   💰 Round-trip WBTC | net PnL: +0.000018 ETH (gas-adjusted)
   ⏳ Sleeping 17s…
```

End-of-session:

```
╔════════════════════════════════════════════════════════════╗
║                  PnL  &  VOLUME  REPORT                   ║
╠════════════════════════════════════════════════════════════╣
║  Session duration   : 423s                                 ║
║  Start balance      : 0.500000 ETH                         ║
║  End   balance      : 0.498723 ETH                         ║
║  Net change         : -0.001277 ETH                        ║
╠════════════════════════════════════════════════════════════╣
║  Successful swaps   : 12                                   ║
║  Successful LP adds : 3                                    ║
║  Arbs captured      : 4                                    ║
║  Failed actions     : 0                                    ║
╠════════════════════════════════════════════════════════════╣
║  Total ETH spent    : 0.024500 ETH                         ║
║  Total ETH received : 0.024050 ETH                         ║
║  Total gas spent    : 0.00082700 ETH                       ║
║  Realized PnL       : -0.001277 ETH                        ║
╚════════════════════════════════════════════════════════════╝
💾 Trade log saved → ./trade-log.json
```

The full per-trade breakdown ends up in `trade-log.json` so you can analyse, plot, or audit later.

---

## Contract Addresses

| Contract | Address |
|---|---|
| V2 Factory | `0x9f653de29013b1e92f0c9749958961c3a64e676d` |
| V2 Router | `0x10d48ce98bdf05be9dafa8d61f147a559c23ab85` |
| V3 Factory | `0xb79fa267550c1bc6079ee5badeaa2b2fd52a2181` |
| V3 SwapRouter | `0xdcc105b5aa8ed0a9e19907b7f606be94167f4e43` |
| V3 QuoterV2 | `0x009c4554f445dfa2e757d9f0452dc7dcc444729a` |
| Position Manager | `0x1b4d07bdfc807dfe4c32b13bc60d009e35b2749b` |
| WETH | `0x4200000000000000000000000000000000000006` |
| USDR (6 dec) | `0x04ed985f0246f00e4e9d158a70a6469e258def05` |
| WBTC (18 dec) | `0xf32d39ff9f6aa7a7a64d7a4f00a54826ef791a55` |

---

## Check your XP

```
https://backend-amma.onrender.com/points/<YOUR_WALLET_ADDRESS>
```
