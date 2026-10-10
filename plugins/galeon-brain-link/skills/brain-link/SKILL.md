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
Enable or disable AI auto-trading. Brain will automatically execute trades on Kuru DEX when signals are strong.

**When to use:** When the user wants hands-free trading. Brain monitors markets 24/7, enters positions when confidence is high, and exits at take-profit or stop-loss levels.

**Example:**
```
brain auto-trade
brain auto-trade --max-per-trade 0.5 --total-limit 10
brain auto-trade --disable
```

**Parameters:**
- `--max-per-trade`: Maximum USDC per single trade (default: 0.5)
- `--total-limit`: Total USDC authorized for all trades (default: 10)
- `--disable`: Revoke auto-trade authorization

**How it works:**
1. User's wallet approves USDC spending to GaleonRouter smart contract
2. GaleonRouter enforces on-chain spending limits (per-trade and total)
3. Brain detects strong signal → pulls USDC from user via contract → swaps on Kuru DEX
4. 0.5% fee collected on-chain per trade
5. Brain monitors position: TP1 (+3%) sells 30%, TP2 (+5%) sells 30%, TP3 (+8%) sells rest, SL at -5%
6. Sale proceeds automatically sent back to user's wallet

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

## API Endpoint

The plugin connects to: `https://brainlink.galeon.world/api/brain-link`

Configurable via `GALEON_BRAIN_API` environment variable.

## Smart Contracts (Monad Mainnet)

- **GaleonRouter:** `0xB7D5aD3ff190B556de41832204530FdA006a85A2` — Handles user authorization, spending limits, fee collection
- **GaleonBrain:** `0xE1E61ecdc2C98f22A83E22a9207b43Bf64e63f98` — Stores AI decisions and trade records on-chain
- **Kuru DEX:** All swaps execute on Kuru Flow (`0xb3e6778480b2E488385E8205eA05E20060B813cb`)
