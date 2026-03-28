/**
 * Automated Swap Bot for Octarine
 * 
 * This script automates the swap/instant redemption flow:
 * 1. Loads environment variables (API URL, Private Key, RPC URL)
 * 2. Initializes an ethers wallet
 * 3. In a loop (every 30s):
 *    - Picks a token pair to swap
 *    - Requests a quote
 *    - Executes the swap (either instant or RFQ)
 * 
 * Usage:
 * export USER_PRIVATE_KEY="0x..."
 * npm run automated-swap
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import {
    createQuoteRequest,
    pollForBids,
    executeTransaction,
    recordFill,
    getSupportedTokens,
    QuoteResponse
} from '../services/api';

// Load environment variables
dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    PRIVATE_KEY: process.env.USER_PRIVATE_KEY || '',
    RPC_URL: process.env.VITE_RPC_URL || 'https://rpc.plume.org',
    CHAIN_ID: parseInt(process.env.VITE_DEFAULT_CHAIN_ID || '98866', 10),
    INTERVAL_MS: 300000, // 300 seconds
    SWAP_AMOUNT: '1000', // 0.001 unit in 6 decimals (pUSD/USDC) or adjust accordingly
};

// ============================================================================
// INITIALIZATION
// ============================================================================

if (!CONFIG.PRIVATE_KEY) {
    console.error('❌ USER_PRIVATE_KEY is not set in environment or .env file');
    process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);

console.log('🚀 Starting Automated Swap Bot');
console.log('==========================================');
console.log(`Wallet: ${wallet.address}`);
console.log(`Chain ID: ${CONFIG.CHAIN_ID}`);
console.log(`Interval: ${CONFIG.INTERVAL_MS / 1000}s`);
console.log('==========================================\n');

/**
 * Main swap execution logic
 */
async function runSwap() {
    console.log(`\n[${new Date().toLocaleTimeString()}] Starting new swap iteration...`);

    try {
        // 1. Get supported tokens to find a pair
        // const tokens = await getSupportedTokens(CONFIG.CHAIN_ID);
        // if (tokens.length < 2) {
        //     console.error('Not enough supported tokens found to perform a swap');
        //     return;
        // }

        // For this automation, we'll swap between the first two tokens
        // In a real scenario, you'd pick specific RWA/Stablecoin pairs
        const sellToken = {
            symbol: 'nBasis',
            address: '0x11113Ff3a60C2450F4b22515cB760417259eE94B',
            collateralType: 'Digital asset',
            accessType: 'Permissionless',
            yield: '0',
            decimals: '6',
        };
        const buyToken = {
            symbol: 'pUSD',
            address: '0xdddD73F5Df1F0DC31373357beAC77545dC5A6f3F',
            collateralType: 'Digital asset',
            accessType: 'Permissionless',
            yield: '0',
            decimals: '6',
        };

        console.log(`[Swap] Pair: Selling ${sellToken.symbol} for ${buyToken.symbol}`);

        // 2. Request a quote
        const quote: QuoteResponse = await createQuoteRequest({
            walletAddress: wallet.address,
            redeemAsset: sellToken.address,
            redemptionAsset: buyToken.address,
            amount: CONFIG.SWAP_AMOUNT, // Adjust based on token decimals
            chainId: CONFIG.CHAIN_ID,
            slippageTolerance: 1,
        });

        if (quote.type === 'instant') {
            console.log('[Swap] Type: Instant');

            // Execute all transactions in the quote
            let txHash = '';
            if (quote.txns && quote.txns.length > 0) {
                console.log(`[Swap] Executing ${quote.txns.length} transactions...`);
                for (const [index, txn] of quote.txns.entries()) {
                    console.log(`[Swap] Executing txn ${index + 1}/${quote.txns.length}...`);
                    txHash = await executeTransaction(txn, wallet);
                }
            } else if (quote.txn) {
                txHash = await executeTransaction(quote.txn, wallet);
            } else {
                console.error('Instant quote missing transaction data');
                return;
            }

            // Record fill
            await recordFill(
                quote.requestId,
                txHash,
                quote.quote?.order?.makerAmount || '0',
                quote.quote?.marketMaker || ''
            );

            console.log(`✅ Instant swap completed: ${txHash}`);
        } else {
            console.log('[Swap] Type: RFQ - Waiting for bids...');

            // Poll for bids and pick the FIRST one (as requested by user)
            const result = await pollForBids(quote.requestId, wallet, {
                maxAttempts: 20,
                pollIntervalMs: 3000,
                bidStrategy: 'first',
            });

            if (result.success) {
                console.log(`✅ RFQ swap completed: ${result.txHash}`);
            } else {
                console.warn(`[Swap] RFQ swap failed or timed out: ${result.error}`);
            }
        }

    } catch (error: any) {
        console.error(`❌ Swap iteration failed: ${error.message}`);
    }
}

/**
 * Bot loop
 */
async function start() {
    // Initial run
    // await runSwap();

    // Schedule next runs
    setInterval(async () => {
        await runSwap();
    }, CONFIG.INTERVAL_MS);
}

// Start the bot
start().catch(error => {
    console.error('Fatal error in bot:', error);
    process.exit(1);
});
