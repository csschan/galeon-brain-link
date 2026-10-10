# Galeon Brain Link

**AI Trading Intelligence Layer for Monad — Built on Kuru DEX**

> Monad Metropolis Hackathon Submission | Track 1: Onchain Finance & Trading

## What is Brain Link?

Brain Link is an AI-powered trading intelligence platform that analyzes tokens using a 12-dimension voting engine and executes automated trades on Kuru DEX on Monad.

Users connect their MetaMask wallet, enable auto-trade with on-chain spending limits, and Brain handles everything — analysis, entry, monitoring, take-profit, stop-loss, and returning proceeds to the user's wallet.

**Live:** [brainlink.galeon.world](https://brainlink.galeon.world)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's MetaMask                       │
│         Approve USDC → Enable Auto-Trade                │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│            GaleonRouter Smart Contract                   │
│  • On-chain authorization (maxPerTrade, totalLimit)     │
│  • pullFundsForTrade() — transfers USDC from user       │
│  • 0.5% fee collection                                  │
│  • Sends net USDC to Oracle for swap execution          │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│              Oracle (Brain Backend)                       │
│  • 12-dimension AI voting engine (every 15 min)         │
│  • Signal: K-line, RSI, Taker, Smart Money, OI, FR...   │
│  • When PASSED → pullFundsForTrade → Kuru swap          │
│  • Monitor: TP1 +3%, TP2 +5%, TP3 +8%, SL -5%         │
│  • Auto-sell on TP/SL → USDC back to user wallet       │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│               Kuru DEX (Monad)                           │
│  • CLOB orderbook — best execution                      │
│  • Flow API: JWT → Quote → Swap                        │
│  • Trading pairs: MON/USDC, WETH/USDC, WBTC/USDC      │
└─────────────────────────────────────────────────────────┘
```

## Smart Contracts (Monad Mainnet)

| Contract | Address |
|----------|---------|
| GaleonRouter V2 | `0xB7D5aD3ff190B556de41832204530FdA006a85A2` |
| GaleonBrain | `0xE1E61ecdc2C98f22A83E22a9207b43Bf64e63f98` |

### GaleonRouter — Key Functions

- `enableAutoTrade(maxPerTrade, totalLimit, durationDays)` — User authorizes auto-trading with on-chain limits
- `pullFundsForTrade(user, tokenIn, amountIn, decisionId)` — Oracle pulls USDC from user, deducts 0.5% fee
- `revokeAutoTrade()` — User revokes authorization anytime
- `isUserAuthorized(user, amount)` — On-chain authorization check

### GaleonBrain — Key Functions

- `publishDecision(asset, direction, score, confidence)` — Oracle publishes AI decisions on-chain
- `recordEndorsedTrade(trader, token, amount, decisionId)` — Records AI-endorsed trades
- `settleTrade(tradeId, pnlBps)` — Settles trade with PnL

## 12-Dimension Voting Engine

Brain analyzes tokens across 12 independent dimensions:

1. **K-line Pattern** — Candlestick structure, consecutive bull/bear candles
2. **RSI** — Relative Strength Index momentum
3. **Funding Rate** — Perpetual futures funding direction
4. **Taker Flow** — Buy/sell taker ratio
5. **Smart Money** — Whale position changes
6. **Open Interest** — OI change direction and magnitude
7. **OI Stage** — Accumulation / distribution phase detection
8. **EMA Cross** — Exponential moving average signals
9. **Multi-day Trend** — Higher timeframe trend alignment
10. **Top Trader LS** — Top trader long/short ratio
11. **Retail LS** — Retail long/short sentiment
12. **BTC Context** — Bitcoin correlation and market regime

Each dimension votes BULL or BEAR with a weighted score. When total score >= 6 and consistency >= 2, signal is PASSED and auto-trade triggers.

## MetaMask Agent Wallet Plugin

6 CLI commands for terminal-based AI trading:

```bash
mm brain check MON          # Pre-trade AI verdict
mm brain decision MON       # Full voting breakdown
mm brain risk MON 100       # Risk assessment
mm brain auto-trade         # Enable auto-trading
mm brain positions          # View active positions
mm brain status             # Service health
```

See [SKILL.md](plugins/galeon-brain-link/skills/brain-link/SKILL.md) for agent instructions.

## Project Structure

```
├── contracts/               # Solidity smart contracts
│   ├── src/
│   │   ├── GaleonBrain.sol  # AI decision storage
│   │   └── GaleonRouter.sol # Auto-trade router with fee collection
│   └── scripts/             # Deployment scripts
├── frontend/                # React frontend (brainlink.galeon.world)
│   └── src/
│       ├── pages/           # BrainLinkHome, AssetPage, TradePage, etc.
│       ├── components/      # UI components (voting bars, activity feed, etc.)
│       ├── services/        # API client, wallet integration
│       └── contracts/       # Frontend contract wrappers
├── server/                  # Node.js backend
│   └── src/
│       ├── controllers/     # API handlers
│       ├── routes/          # 15+ API endpoints
│       ├── services/        # Auto-trade, Kuru swap, Oracle
│       └── config/          # Contract addresses
└── plugins/                 # MetaMask Agent Wallet plugin
    └── galeon-brain-link/
        ├── src/commands/    # 6 CLI commands
        └── skills/          # SKILL.md for agent integration
```

## Auto-Trade Flow

1. **User** connects MetaMask, approves USDC to GaleonRouter, calls `enableAutoTrade()`
2. **Brain** runs 12-dimension analysis every 15 minutes on MON, ETH, BTC, SOL
3. **Signal PASSED** (score >= 6) → Oracle calls `pullFundsForTrade()` on GaleonRouter
4. **GaleonRouter** transfers USDC from user, collects 0.5% fee, sends net to Oracle
5. **Oracle** swaps USDC → token on Kuru DEX
6. **Brain monitors** position every 30 seconds
7. **TP/SL hit** → Oracle sells on Kuru → sends USDC back to user's wallet

## Tech Stack

- **Blockchain:** Monad (Chain ID 143, 0.8s blocks)
- **DEX:** Kuru (CLOB orderbook, Flow API)
- **Contracts:** Solidity 0.8.28, Hardhat, viaIR
- **Frontend:** React, TypeScript
- **Backend:** Node.js, Express
- **Wallet:** MetaMask (Monad EVM)
- **Data:** Binance API (price feeds), MarketDataCache (WebSocket)

## License

MIT
