# Galeon Brain Link — AI Trading Intelligence for Monad

## Overview

Galeon Brain Link is an AI-powered trading intelligence plugin that analyzes tokens using a 12-dimension voting engine and executes automated trades on Kuru DEX on Monad. The agent can check signals, assess risk, manage auto-trading, and monitor positions — all on behalf of the user.

## Available Commands

### `brain check <token>`
Get Brain's AI verdict before trading. Returns direction (LONG/SHORT/WAIT), confidence %, risk level, and suggested position size.

**When to use:** Before any swap on Kuru DEX. Always check Brain's opinion first.

**Example:**
```
brain check MON
brain check MON --amount 50
brain check WETH
```

**Output:** Direction, confidence score (0-75%), risk level (LOW/MEDIUM/HIGH), win rate from similar setups, suggested trade size.

### `brain decision <token>`
Get full 12-dimension voting breakdown. Shows how each dimension voted and why.

**When to use:** When the user wants to understand WHY Brain recommends a direction.

**Example:**
```
brain decision MON
brain decision WETH
```

**Output:** Each dimension (K-line, RSI, Funding Rate, Taker Flow, Smart Money, Open Interest, EMA, Multi-day Trend, etc.) with individual score, direction, and reasoning.

### `brain risk <token> <amount>`
Assess risk for a specific trade size.

**When to use:** When the user wants to know if a trade amount is safe given current market conditions.

**Example:**
```
brain risk MON 100
brain risk WETH 500
```

**Output:** PASS / ADJUST / REJECT verdict with explanation, suggested adjustments if needed.

### `brain auto-trade`
Enable agentic AI auto-trading. The Agent Wallet autonomously executes trades on Kuru DEX — no intermediary, no third-party custody. Funds stay in the Agent Wallet at all times.

**When to use:** When the user wants fully autonomous AI trading. The agent monitors Brain signals and trades directly from the Agent Wallet.

**Example:**
```
brain auto-trade
brain auto-trade --max-per-trade 0.5 --total-limit 10
brain auto-trade --disable
```

**Parameters:**
- `--max-per-trade`: Maximum USDC per single trade (default: 0.5)
- `--total-limit`: Total USDC authorized for all trades (default: 10)
- `--interval`: Scan interval in minutes (default: 15)
- `--disable`: Stop auto-trading

**How it works (uses `wallet-submit` capability):**
1. Agent approves USDC to Kuru DEX via `io.wallet.submitTransaction()`
2. Agent starts a monitoring loop — polls Brain API every N minutes
3. Brain signal PASSED → Agent gets Kuru swap quote → Agent Wallet signs and sends swap TX directly to Kuru
4. Agent tracks position in memory — monitors price every 30 seconds
5. TP1 (+3%) → Agent Wallet sells 30% on Kuru. TP2 (+5%) → sells 30%. TP3 (+8%) → sells rest
6. SL (-5%) → Agent Wallet sells all on Kuru
7. All USDC proceeds remain in the Agent Wallet — no third party ever touches the funds

**On-chain transactions autonomously sent by the agent:**
- `USDC.approve(KuruFlow, totalLimit)` — one-time approval for Kuru DEX
- Kuru swap calldata (buy) — when Brain signal is PASSED
- `WMON.deposit()` + `WMON.approve(KuruFlow)` — wrap MON before selling
- Kuru swap calldata (sell) — when TP or SL is hit

**Key principle:** The Agent Wallet is the trader. No Oracle wallet, no intermediary contract for swaps. The agent decides when to trade based on Brain's 12-dimension AI analysis, and the Agent Wallet executes directly on Kuru DEX.

### `brain positions`
View all active AI-managed positions with live PnL.

**When to use:** To check what Brain is currently holding and how positions are performing.

**Example:**
```
brain positions
```

**Output:** List of active positions with: token, entry price, current price, PnL %, amount held, TP/SL levels, time held.

### `brain status`
Check Brain Link service status and recent activity.

**When to use:** To verify Brain is running and see recent events.

**Example:**
```
brain status
```

**Output:** Service uptime, last analysis time, number of active positions, recent activity feed.

## Agent Decision Guidelines

- **Always run `brain check` before executing a swap.** If Brain says WAIT or confidence is below 30%, advise the user to wait.
- **If Brain says LONG with confidence above 55%**, the signal is strong. Proceed with the trade at suggested size.
- **If risk assessment returns ADJUST**, reduce the trade amount to Brain's suggested size.
- **If risk assessment returns REJECT**, do not execute the trade. Explain why to the user.
- **For auto-trade**, recommend conservative limits for new users: $0.50 per trade, $10 total limit.
- **Check positions periodically** to keep the user informed about active trades.

## Requirements

- **`@metamask/agent-wallet` v7.1.0+** — Required for Monad (chain-id 143) support. Earlier versions (≤ v6.x) return `UNSUPPORTED_CHAIN` on Monad.
- **Node.js v22.22.1+** — Required by v7.1.0.
- **Beast Mode** — Agent Wallet must be initialized with `mm init --wallet server-wallet --mode beast` so auto-trade can sign transactions without user confirmation.

## Verified on Monad Mainnet

Real transaction executed via MetaMask Agent Wallet on Monad:
- **TX:** `0xf1c4aa49a63bdc78...`
- **Action:** Bought 20.22 MON @ $0.024729 via Kuru DEX
- **Agent Wallet:** `0xedab5f1847f60f0e6353f6a804f6a3525b631f98`
- **Command:** `mm wallet send-transaction --chain-id 143 --payload {...} --wait --json`

## API Endpoint

The plugin connects to: `https://brainlink.galeon.world/api/brain-link`

Configurable via `GALEON_BRAIN_API` environment variable.

## Smart Contracts (Monad Mainnet)

- **GaleonRouter:** `0xB7D5aD3ff190B556de41832204530FdA006a85A2` — Handles user authorization, spending limits, fee collection
- **GaleonBrain:** `0xE1E61ecdc2C98f22A83E22a9207b43Bf64e63f98` — Stores AI decisions and trade records on-chain
- **Kuru DEX:** All swaps execute on Kuru Flow (`0xb3e6778480b2E488385E8205eA05E20060B813cb`)
