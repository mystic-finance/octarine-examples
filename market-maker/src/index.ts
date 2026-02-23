/**
 * Octarine Market Maker Bot - Unified Entry Point
 * 
 * This is the main entry point for the market maker bot, which runs two services
 * concurrently:
 * 
 * 1. **Instant Redemption Bidding**: Handles RFQ (Request for Quote) requests
 *    where users want to redeem RWA tokens for stablecoins.
 * 
 * 2. **Liquidation Monitoring**: Watches for underwater positions and triggers
 *    liquidations to earn bonuses.
 * 
 * ## Architecture
 * 
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    Market Maker Bot                            │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  ┌──────────────────┐    ┌──────────────────┐                  │
 * │  │  RFQ Bidding     │    │  Liquidations    │                  │
 * │  │  Service         │    │  Monitor         │                  │
 * │  │                  │    │                  │                  │
 * │  │ • Polls API for  │    │ • Polls API for  │                  │
 * │  │   new RFQs       │    │   liquidations   │                  │
 * │  │ • Calculates     │    │ • Evaluates      │                  │
 * │  │   quotes         │    │   profitability  │                  │
 * │  │ • Signs orders   │    │ • Signs orders   │                  │
 * │  │ • Submits bids   │    │ • Triggers liqs  │                  │
 * │  └──────────────────┘    └──────────────────┘                  │
 * │           │                        │                          │
 * │           └──────────┬─────────────┘                          │
 * │                      ▼                                         │
 * │         ┌──────────────────────┐                              │
 * │         │   Octarine API       │                              │
 * │         │   (REST/WebSocket)   │                              │
 * │         └──────────────────────┘                              │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 * 
 * ## Getting Started
 * 
 * ```bash
 * # 1. Install dependencies
 * npm install
 * 
 * # 2. Configure environment
 * cp .env.example .env
 * # Edit .env with your credentials
 * 
 * # 3. Run the bot
 * npm start
 * ```
 * 
 * ## Environment Variables
 * 
 * Required:
 * - `PRIVATE_KEY` - Your EVM private key (with 0x prefix)
 * - `MARKET_MAKER_ADDRESS` - Your wallet address
 * - `MARKET_MAKER_API_KEY` - Your Octarine API key
 * 
 * Optional (see config.ts for full list):
 * - `PRICE_SPREAD` - Default: 0.98 (2% profit margin)
 * - `SUPPORTED_CHAINS` - Default: 98866 (Plume)
 * - `LOG_LEVEL` - Default: 3 (INFO)
 * 
 * ## Monitoring
 * 
 * The bot logs structured output to stdout. Use your preferred log aggregation
 * service (Datadog, CloudWatch, etc.) for production monitoring.
 * 
 * ## Graceful Shutdown
 * 
 * The bot handles SIGINT/SIGTERM signals to complete in-progress operations
 * before exiting.
 */

import { startBiddingLoop } from './instant-redemption-bidding';
import { startLiquidationMonitor } from './liquidation-trigger';
import { logger } from './utils/logger';
import { CONFIG } from './config';

// ============================================================================
// PROCESS MANAGEMENT
// ============================================================================

/**
 * Graceful shutdown handler.
 * Allows the bot to finish current operations before exiting.
 */
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        logger.warn('Force shutdown initiated...');
        process.exit(1);
    }

    isShuttingDown = true;
    logger.info(`\n📡 Received ${signal}. Starting graceful shutdown...`);
    logger.info('Waiting for current operations to complete...');

    // Give operations a chance to complete
    // Note: Since our loops run indefinitely, this is mainly for clean logging
    setTimeout(() => {
        logger.info('👋 Shutdown complete. Goodbye!');
        process.exit(0);
    }, 2000);
}

// Register shutdown handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {}, error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {}, reason as Error);
});

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
    logger.info('\n╔══════════════════════════════════════════════════════════════╗');
    logger.info('║          🚀 Octarine Market Maker Bot v2.0.0                 ║');
    logger.info('╠══════════════════════════════════════════════════════════════╣');
    logger.info('║  Services: Bidding + Liquidations                            ║');
    logger.info('║  Docs: https://docs.mysticfinance.xyz                        ║');
    logger.info('╚══════════════════════════════════════════════════════════════╝\n');

    // Log configuration (without sensitive data)
    logger.info('Configuration Summary:');
    logger.info(`  API Endpoint: ${CONFIG.API_BASE_URL}`);
    logger.info(`  Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);
    logger.info(`  Supported Chains: [${CONFIG.SUPPORTED_CHAINS.join(', ')}]`);
    logger.info(`  Bid Spread: ${(1 - CONFIG.BIDDING.priceSpread) * 100}%`);
    logger.info(`  Liquidation Min HF: ${CONFIG.LIQUIDATION.minHealthFactor}`);
    logger.info(`  Poll Intervals: Bidding=${CONFIG.MONITORING.biddingPollIntervalMs}ms, Liquidation=${CONFIG.MONITORING.liquidationPollIntervalMs}ms`);
    logger.info('');

    // Start both services concurrently
    logger.info('Starting services...\n');

    try {
        await Promise.all([
            // RFQ Bidding Service
            startBiddingLoop().catch((error) => {
                logger.error('Bidding loop crashed', {}, error);
                throw error;
            }),
            
            // Liquidation Monitoring Service
            startLiquidationMonitor().catch((error) => {
                logger.error('Liquidation monitor crashed', {}, error);
                throw error;
            }),
        ]);
    } catch (error) {
        // Both services run infinite loops, so this only catches startup failures
        // or unexpected crashes (shouldn't happen with proper error handling)
        logger.error('A critical service failed', {}, error as Error);
        process.exit(1);
    }

    // This line is technically unreachable since the loops run forever
    logger.info('All services have stopped');
}

// Only run main if this file is executed directly
if (require.main === module) {
    main().catch((error) => {
        logger.error('Bot startup failed', {}, error);
        process.exit(1);
    });
}

// Export for testing
export { main };
