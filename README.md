# Octarine Market Maker Examples

[![Documentation](https://img.shields.io/badge/docs-mysticfinance.xyz-blue)](https://docs.mysticfinance.xyz)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

This repository contains production-ready example implementations for interacting with the **Octarine** protocol by Mystic Finance. Octarine enables instant redemptions of RWA (Real World Asset) tokens through a competitive market maker mechanism.

## 📚 Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Market Maker Bot](#-market-maker-bot)
  - [Features](#features)
  - [Architecture](#architecture)
  - [Configuration](#configuration)
  - [Running the Bot](#running-the-bot)
- [User Application](#-user-application)
- [API Reference](#api-reference)
- [Liquidations](#liquidations)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)

---

## Overview

Octarine consists of two main components:

| Component | Description |
|-----------|-------------|
| **Market Maker Bot** | Automated bot that competitively bids on user redemption requests (RFQs) and monitors for liquidation opportunities |
| **User Application** | Simple React frontend for users to request quotes and execute swaps |

### How It Works

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│    User      │────────▶│   Octarine   │◀────────│ Market Maker │
│   (dApp)     │  RFQ    │     API      │   Bid   │    (Bot)     │
└──────────────┘         └──────────────┘         └──────────────┘
       │                           │                       │
       │◀──────────────────────────┘                       │
       │              Best Quote Selected                   │
       │                                                  │
       └──────────────────────────────────────────────────▶│
                    On-chain Settlement
```

---

## Quick Start

### Prerequisites

- Node.js 18+ (with npm)
- An EVM wallet with private key
- Octarine API key ([Request access](https://mysticfinance.xyz))

### 1. Clone and Setup

```bash
git clone https://github.com/mystic-finance/octarine-examples.git
cd octarine-examples
```

### 2. Market Maker Bot

```bash
cd market-maker
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# Run the bot
npm start
```

### 3. User Application (Optional)

```bash
cd ../user
npm install
npm run dev
```

---

## 🤖 Market Maker Bot

Located in `/market-maker/`, this is a production-ready trading bot for professional market makers.

### Features

- ✅ **RFQ Bidding**: Compete on redemption quotes with automatic order signing
- ✅ **Liquidation Monitor**: Earn liquidation bonuses from underwater positions
- ✅ **Gas Optimization**: EIP-1559 support with configurable gas strategies
- ✅ **Resilient Architecture**: Circuit breakers, exponential backoff, error recovery
- ✅ **Risk Management**: Token whitelisting, position limits, blacklists
- ✅ **Structured Logging**: Configurable log levels with context
- ✅ **Graceful Shutdown**: Completes in-flight operations before exiting

### Architecture

```
market-maker/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── config.ts                   # Configuration management
│   ├── instant-redemption-bidding.ts   # RFQ bidding service
│   ├── liquidation-trigger.ts      # Liquidation monitoring
│   ├── approvals.ts                # Token approval management
│   └── utils/
│       ├── logger.ts              # Structured logging
│       ├── retry.ts               # Exponential backoff
│       └── gas.ts                 # Gas pricing & estimation
├── .env.example                   # Configuration template
├── package.json
└── tsconfig.json
```

### Configuration

All configuration is via environment variables. See `.env.example` for all options.

#### Required Variables

```bash
PRIVATE_KEY=0x...                    # Your EVM private key
MARKET_MAKER_ADDRESS=0x...           # Your wallet address
MARKET_MAKER_API_KEY=your-key        # Your Octarine API key
```

#### Key Optional Settings

```bash
# Pricing
PRICE_SPREAD=0.98                    # 2% profit margin (0.98 = 98% of market price)

# Settlement
SETTLEMENT_TYPE=instant              # 'instant' (default) or 'delayed'
ESTIMATED_SETTLEMENT_TIME=24         # Hours until settlement (required for delayed)

# Chains & Tokens
SUPPORTED_CHAINS=98866               # Plume mainnet
ACCEPTED_TOKENS=*                    # Accept all, or comma-separated addresses

# Liquidation Settings
LIQUIDATION_MIN_PROFIT=5             # 5% minimum profit margin
LIQUIDATION_GAS_SPEED=fast           # fast gas for liquidations

# Performance
BIDDING_POLL_INTERVAL_MS=5000        # Poll every 5 seconds
LOG_LEVEL=3                          # INFO level
```

### Running the Bot

```bash
# Production (compiled)
npm run build
npm start

# Development (with auto-reload)
npx ts-node src/index.ts

# Run services individually
npm run bid        # RFQ bidding only
npm run liquidate  # Liquidations only
```

### Monitoring

The bot outputs structured JSON logs:

```json
[2024-01-15T10:30:00.000Z] [INFO] Fetched 5 pending RFQ requests {"count":5}
[2024-01-15T10:30:01.000Z] [INFO] Successfully bid on req_123abc {"requestId":"req_123abc"}
```

For production, integrate with:
- Datadog
- CloudWatch
- Splunk
- Grafana Loki

---

## 👤 User Application

Located in `/user/`, this is a reference React application demonstrating the swap flow.

### Features

- Wallet connection (MetaMask / WalletConnect)
- Token approval handling
- Instant swap execution (pre-approved quotes)
- RFQ polling (competitive bidding)

### Running

```bash
cd user
npm install
npm run dev
# Open http://localhost:5173
```

---

## API Reference

### Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/octarine/requests` | GET | List pending RFQ requests |
| `/octarine/bid` | POST | Submit a bid on an RFQ |
| `/octarine/transform` | POST | Execute settlement for won bid |
| `/octarine/liquidations/opportunities` | GET | List liquidatable positions |
| `/octarine/liquidations/bid` | POST | Trigger a liquidation |

### Authentication

Include your API key in the `x-api-key` header:

```bash
curl -H "x-api-key: your-key" https://api.mysticfinance.xyz/octarine/requests
```

---

## Liquidations

Liquidations are a key profit opportunity for market makers in the Octarine protocol.

### When Positions Become Liquidatable

A position becomes liquidatable when its **Health Factor (HF)** falls below 1.0:

```
Health Factor = Collateral Value / Debt Value

HF > 1.0: Position is healthy
HF < 1.0: Position can be liquidated
```

### The Liquidation Process

1. **Monitor**: Poll `/octarine/liquidations/opportunities`
2. **Evaluate**: Check if liquidation is profitable after gas costs
3. **Approve**: Ensure debt token is approved for the exchange proxy
4. **Sign**: Create and sign 0x Limit Order for the liquidation
5. **Execute**: Submit to `/octarine/liquidations/bid`
6. **Profit**: Receive bonus collateral worth more than debt repaid

### Profit Calculation

```
Liquidation Bonus (e.g., 5%)
↓
Debt Repaid: 1000 USDC
Collateral Received: 1050 USD worth of tokens
Gross Profit: 50 USD
Net Profit: 50 USD - Gas Costs
```

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `PRIVATE_KEY not set` | Ensure `.env` file exists and PRIVATE_KEY is set with 0x prefix |
| `insufficient funds` | Your wallet needs gas tokens (ETH) for transaction fees |
| `Invalid API key` | Check MARKET_MAKER_API_KEY in your .env |
| `Insufficient balance` | The token you're offering needs sufficient balance in your wallet |

### Debug Mode

Enable detailed logging:

```bash
LOG_LEVEL=5 npm start  # TRACE level
```

---

## Security

### Best Practices

1. **Private Key Security**
   - Never commit `.env` files
   - Use hardware wallets for mainnet
   - Rotate keys regularly

2. **Token Approvals**
   - The bot uses unlimited approvals for gas efficiency
   - Review approved spenders periodically
   - Use dedicated market maker wallets

3. **API Keys**
   - Treat API keys like passwords
   - Use separate keys for dev/staging/production
   - Rotate if compromised

### Environment Isolation

```bash
# Production
NODE_ENV=production API_BASE_URL=https://api.mysticfinance.xyz npm start

# Staging
NODE_ENV=staging API_BASE_URL=https://staging-api.mysticfinance.xyz npm start
```

---

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Code Style

- Use TypeScript for all new code
- Follow existing file structure
- Add JSDoc comments for public functions
- Include error handling with proper logging

---

## Support

- 📖 [Documentation](https://docs.mysticfinance.xyz)
- 💬 [Discord](https://discord.gg/mystic)
- 🐛 [Issue Tracker](https://github.com/mystic-finance/octarine-examples/issues)

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

<p align="center">
  Built with ❤️ by <a href="https://mysticfinance.xyz">Mystic Finance</a>
</p>
