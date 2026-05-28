# 📈 Testnet Volume Bot — Swap & Add Liquidity

Automates testnet trading activity on any **Uniswap V2-compatible DEX** (Uniswap, Sushiswap, Quickswap, etc.) to generate swap volume and liquidity positions.

---

## Features

| Feature | Details |
|---|---|
| 🔄 Swap rounds | ETH → Token → ETH, configurable rounds & amounts |
| 💧 Add liquidity | Buys tokens then pairs them with ETH in the pool |
| ⚙️ Configurable | Slippage, delay, rounds, amounts all via `.env` |
| 🛡️ Safe | Slippage protection, auto-approval, deadline guard |
| 🌐 Multi-network | Works on any EVM testnet with a V2 router |

---

## Supported Testnets

| Network | Chain ID | RPC |
|---|---|---|
| Ethereum Sepolia | 11155111 | `https://rpc.sepolia.org` |
| Polygon Mumbai | 80001 | `https://rpc-mumbai.maticvigil.com` |
| Arbitrum Sepolia | 421614 | `https://sepolia-rollup.arbitrum.io/rpc` |
| Base Sepolia | 84532 | `https://sepolia.base.org` |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY
RPC_URL=https://rpc.sepolia.org
ROUTER_ADDRESS=0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008
TOKEN_A=0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9   # WETH on Sepolia
TOKEN_B=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238   # USDC mock on Sepolia
```

> ⚠️ **Never use a wallet with real funds. Testnet only.**

### 3. Get testnet ETH

- Sepolia faucet: https://sepoliafaucet.com
- Alchemy faucet: https://www.alchemy.com/faucets/ethereum-sepolia
- Polygon Mumbai faucet: https://faucet.polygon.technology

---

## Usage

```bash
# Run swaps only (ETH → Token → ETH, N rounds)
npm run swap

# Add liquidity only
npm run liquidity

# Run swaps AND add liquidity (default)
npm run both

# Or directly with node
node scripts/volumeBot.js --mode both
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Wallet private key (testnet only!) |
| `RPC_URL` | — | JSON-RPC endpoint for your testnet |
| `ROUTER_ADDRESS` | — | Uniswap V2-compatible router address |
| `TOKEN_A` | — | Token A address (usually WETH) |
| `TOKEN_B` | — | Token B address to trade against |
| `SWAP_ROUNDS` | `10` | Number of buy/sell swap cycles |
| `SWAP_AMOUNT_ETH` | `0.001` | ETH per swap round |
| `DELAY_SECONDS` | `15` | Seconds between each round |
| `SLIPPAGE_PERCENT` | `5` | Slippage tolerance (%) |
| `DEADLINE_OFFSET` | `300` | Tx deadline in seconds from now |

---

## How It Works

### Swap Round
```
ETH ──[swapExactETHForTokens]──► TOKEN_B
TOKEN_B ──[swapExactTokensForETH]──► ETH
```
Each round performs a buy then a sell, generating **2 on-chain swaps** per round.

### Add Liquidity
```
ETH/2 ──[swapExactETHForTokens]──► TOKEN_B
ETH/2 + TOKEN_B ──[addLiquidityETH]──► LP tokens
```
Buys tokens with half the configured ETH, then pairs the remaining ETH + tokens into the liquidity pool.

---

## Example Output

```
[2024-01-15T10:00:00.000Z] 🚀  Volume Bot starting  [mode=both]
[2024-01-15T10:00:01.000Z]     Network : sepolia (chainId=11155111)
[2024-01-15T10:00:01.000Z]     Address : 0xABC...123
[2024-01-15T10:00:01.000Z]     Balance : 0.5 ETH

[2024-01-15T10:00:01.000Z] 📊  Running 10 swap rounds  (0.001 ETH each)

[2024-01-15T10:00:01.000Z] ── Swap round 1 ──────────────────────────
[2024-01-15T10:00:01.000Z] ▶  BUY  0.001 ETH → USDC
[2024-01-15T10:00:15.000Z]    ✅ BUY confirmed  block=5123456  tx=0xabc...
[2024-01-15T10:00:18.000Z] ▶  SELL 1.82 USDC → ETH
[2024-01-15T10:00:32.000Z]    ✅ SELL confirmed  block=5123459  tx=0xdef...
```

---

## Project Structure

```
monitoring-signal-alpha/
├── scripts/
│   └── volumeBot.js      # Main bot script
├── .env.example          # Environment variable template
├── package.json
└── README.md
```

---

## Security Notes

- 🔑 Never commit your `.env` file — it contains your private key
- 🧪 Only use throwaway testnet wallets
- 💸 Keep testnet ETH amounts small to avoid wasting faucet funds
- `.env` is already in `.gitignore` by convention — double-check before pushing
