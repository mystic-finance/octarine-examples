# Octarine Examples & Projects

This repository contains example implementations and full projects for interacting with the **Octarine** protocol (Mystic Finance).

## 📂 Directory Structure

- **`market-maker/`**: A complete Market Maker bot for handling Instant Redemption Bids and Liquidation Triggers.
- **`user/`**: A React-based web application for users to Request Quotes and Swap Tokens.
- **`examples/`**: Standalone scripts demonstrating specific API interactions (Redemption, Liquidation, Swap).

---

## 🤖 Market Maker Bot (`/market-maker`)

A centralized bot for market makers to participate in the Octarine ecosystem.

### Features
- **Instant Redemption Bidding**: Automatically polls for RFQ requests and submits bids based on configurable spread.
- **Liquidation Triggers**: Monitors for underwater positions and triggers liquidations to earn bonuses.
- **Unified Execution**: Run both services concurrently.

### Quick Start
1.  Navigate to the directory:
    ```bash
    cd market-maker
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Configure environment:
    - Create a `.env` file (see `.env.example` or strictly follow the template).
    - Set `PRIVATE_KEY`, `MARKET_MAKER_ADDRESS`, and `ACCEPTED_TOKENS`.
4.  Run the bot:
    ```bash
    npm start
    ```

---

## 👤 User Application (`/user`)

A simple frontend for end-users to redemptions/swaps.

### Features
- **Wallet Connection**: Supports MetaMask and other Injected Wallets.
- **Swap Interface**: Simple UI to input Token In, Token Out, and Amount.
- **Smart Routing**: Automatically handles "Instant" (Pre-Approved) swaps vs. "RFQ" (Bidding) flows.

### Quick Start
1.  Navigate to the directory:
    ```bash
    cd user
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start Development Server:
    ```bash
    npm run dev
    ```
4.  Open `http://localhost:3000` (or the URL shown in terminal).

---

## 📚 Examples (`/examples`)

Original reference scripts for understanding individual components.

- `redemption/instant-redemption-bidding.ts`: Reference logic for bidding.
- `liquidation/liquidation-trigger.ts`: Reference logic for liquidations.
- `swap/verify-swap.ts`: Reference logic for user swaps.

---

## 🛠 Configuration

Make sure to construct your `.env` files correctly in each project directory. 

**Note**: The root `.gitignore` is set up to exclude `.env` files and `node_modules` to prevent accidental commits of sensitive data.
