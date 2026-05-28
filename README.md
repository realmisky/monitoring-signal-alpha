# 📈 RISE Testnet Volume Bot — Helios Trade

Generates swap + liquidity activity on **[Helios Trade](https://testnet.helios.trade)**, a Uniswap V3-compatible DEX running on the **RISE Chain Testnet** (Chain ID: 11155931).

---

## Features

| Feature | Details |
|---|---|
| 🔄 Swap rounds | Wraps ETH → WETH → Token → WETH → ETH, configurable rounds |
| 💧 Add liquidity | Buys tokens then mints a V3 LP position (wide tick range) |
| ⚙️ Configurable | Fee tier, slippage, delay, rounds, amounts all via `.env` |
| ⚡ RISE-native | Uses `testnet.riselabs.xyz` RPC, sub-second confirmations |
| 🛡️ Safe | Slippage protection, auto-approval, deadline guard |

---

## Network Info

| Property | Value |
|---|---|
| **Network** | RISE Testnet |
| **Chain ID** | `11155931` |
| **RPC** | `https://testnet.riselabs.xyz` |
| **Explorer** | `https://explorer.testnet.risechain.com` |
| **Faucet** | `https://faucet.testnet.riselabs.xyz` |
| **Portal** | `https://portal.risechain.com` |
| **Helios DEX** | `https://testnet.helios.trade/swap` |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Get testnet ETH

Go to the [RISE Testnet Faucet](https://portal.risechain.com) or [backup faucet](https://faucet.testnet.riselabs.xyz) and drip ETH to your wallet.

### 3. Find the Helios contract addresses

1. Go to [testnet.helios.trade/swap](https://testnet.helios.trade/swap)
2. Connect your wallet and do a small manual swap
3. Open the transaction in the [RISE Explorer](https://explorer.testnet.risechain.com)
4. Note the **SwapRouter** contract address (the `to` address of your tx)
5. For the **Position Manager**, go to the "Add Liquidity" tab on Helios and do the same

### 4. Configure

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY

RPC_URL=https://testnet.riselabs.xyz

SWAP_ROUTER=0xHeliosSwapRouterAddress
POSITION_MANAGER=0xHeliosPositionManagerAddress

WETH_ADDRESS=0xWETHOnRiseTestnet
TOKEN_ADDRESS=0x50524C5bDa18aE25C600a8b81449B9CeAeB50471   # USDC
```

> ⚠️ **Never use a real wallet. Testnet only.**

### 5. Run

```bash
# Swaps only (ETH wrap → buy → sell → unwrap, N rounds)
npm run swap

# Add liquidity only
npm run liquidity

# Swaps + add liquidity (default)
npm run both
```

---

## Known Token Addresses on RISE Testnet

| Token | Address |
|---|---|
| USDC | `0x50524C5bDa18aE25C600a8b81449B9CeAeB50471` |
| USDT | `0x9190159b1bb78482Dca6EBaDf03ab744de0c0197` |
| BTC  | `0xadDAEd879D549E5DBfaf3e35470C20D8C50fDed0` |

*Source: [docs.risechain.com/docs/builders/testnet-tokens](https://docs.risechain.com/docs/builders/testnet-tokens)*

---

## How It Works

### Swap Round
```
ETH
 └─ wrap ──────────────────► WETH
 └─ exactInputSingle ──────► TOKEN
 └─ exactInputSingle ──────► WETH
 └─ unwrap ────────────────► ETH
```
Each round = **2 on-chain swaps** (buy + sell).

### Add Liquidity
```
ETH
 └─ wrap ──────────────────► WETH (full amount)
 └─ exactInputSingle ──────► TOKEN (half WETH spent)
 └─ positionManager.mint ──► LP NFT (WETH + TOKEN paired)
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Wallet private key |
| `RPC_URL` | `https://testnet.riselabs.xyz` | RISE testnet RPC |
| `SWAP_ROUTER` | — | Helios SwapRouter address |
| `POSITION_MANAGER` | — | Helios PositionManager address |
| `WETH_ADDRESS` | — | WETH token on RISE testnet |
| `TOKEN_ADDRESS` | — | Token to swap (e.g. USDC) |
| `POOL_FEE` | `3000` | 500 / 3000 / 10000 |
| `SWAP_ROUNDS` | `10` | Number of buy+sell cycles |
| `SWAP_AMOUNT_ETH` | `0.001` | ETH per round |
| `DELAY_SECONDS` | `12` | Wait between rounds |
| `SLIPPAGE_PERCENT` | `5` | Slippage tolerance |
| `DEADLINE_OFFSET` | `300` | Tx deadline (seconds) |

---

## Project Structure

```
monitoring-signal-alpha/
├── scripts/
│   └── volumeBot.js      # Main bot (swap + liquidity)
├── .env.example          # Config template
├── .gitignore            # Keeps .env out of git
├── package.json
└── README.md
```

---

## Security

- 🔑 `.env` is gitignored — never commit your private key
- 🧪 Testnet wallets only — no real value at risk
- ✅ `amountOutMinimum: 0n` is fine for testnet, increase it for prod use
