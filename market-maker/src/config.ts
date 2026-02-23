/**
 * Octarine Market Maker Configuration
 * 
 * Centralized configuration management with validation and environment-specific settings.
 * All sensitive values (private keys, API keys) should be set via environment variables.
 * 
 * @example
 * ```bash
 * # Minimum required environment variables
 * export PRIVATE_KEY="0x..."
 * export MARKET_MAKER_ADDRESS="0x..."
 * export MARKET_MAKER_API_KEY="your-api-key"
 * ```
 */

import * as dotenv from 'dotenv';
import { LogLevel } from './utils/logger';

dotenv.config();

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface LiquidationConfig {
    /** Maximum percentage of debt that can be liquidated in a single transaction (0.0 - 1.0) */
    maxLiquidationRatio: number;
    /** Minimum health factor for a position to be considered for liquidation (typically < 1.0) */
    minHealthFactor: number;
    /** Profit margin required to trigger liquidation (as percentage, e.g., 5 = 5%) */
    minProfitMarginPercent: number;
    /** Maximum gas price willing to pay for liquidation transactions (in gwei) */
    maxGasPriceGwei: number;
    /** Speed priority for liquidation transactions */
    gasSpeed: 'slow' | 'standard' | 'fast' | 'urgent';
    /** Bid expiry time in minutes */
    bidExpiryMinutes: number;
}

export interface BiddingConfig {
    /** Spread applied to quotes (0.98 = 2% spread/market maker profit) */
    priceSpread: number;
    /** Minimum bid amount in wei to prevent dust transactions */
    minBidAmountWei: string;
    /** Whether to auto-approve tokens before bidding */
    autoApproveTokens: boolean;
    /** Maximum gas price for bidding transactions (in gwei) */
    maxGasPriceGwei: number;
    /** Speed priority for bidding transactions */
    gasSpeed: 'slow' | 'standard' | 'fast' | 'urgent';
    /** Bid validity period in minutes */
    bidExpiryMinutes: number;
}

export interface MonitoringConfig {
    /** Polling interval for new RFQ requests (milliseconds) */
    biddingPollIntervalMs: number;
    /** Polling interval for liquidation opportunities (milliseconds) */
    liquidationPollIntervalMs: number;
    /** Maximum number of tracked requests before cleanup */
    maxTrackedRequests: number;
    /** Health check interval for the bot (milliseconds) */
    healthCheckIntervalMs: number;
}

export interface RiskManagementConfig {
    /** Maximum USD value of a single position (for capital allocation) */
    maxPositionUsd: number;
    /** Maximum total exposure across all positions */
    maxTotalExposureUsd: number;
    /** Tokens to blacklist (addresses) */
    blacklistedTokens: string[];
    /** Require manual confirmation for transactions above this threshold (in USD) */
    manualConfirmationThresholdUsd: number;
}

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

/**
 * Parse comma-separated environment variable into array
 */
function parseList(envValue: string | undefined, defaultValue: string[]): string[] {
    if (!envValue) return defaultValue;
    return envValue.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Parse integer array from environment variable
 */
function parseIntList(envValue: string | undefined, defaultValue: number[]): number[] {
    const list = parseList(envValue, defaultValue.map(String));
    return list.map(s => parseInt(s, 10)).filter(n => !isNaN(n));
}

/**
 * Safe environment variable getter with default
 */
function getEnv(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (value === undefined && defaultValue === undefined) {
        throw new Error(`Required environment variable ${key} is not set`);
    }
    return value || defaultValue!;
}

// ============================================================================
// MAIN CONFIGURATION OBJECT
// ============================================================================

export const CONFIG = {
    // ---------------------------------------------------------------------
    // Connection Settings
    // ---------------------------------------------------------------------
    
    /** Base URL for the Octarine API */
    API_BASE_URL: getEnv('API_BASE_URL', 'https://api.mysticfinance.xyz'),
    
    /** API key for authenticated endpoints */
    API_KEY: process.env.MARKET_MAKER_API_KEY || '',
    
    /** Market maker's private key (EVM format with 0x prefix) */
    PRIVATE_KEY: getEnv('PRIVATE_KEY'),
    
    /** Market maker's wallet address */
    MARKET_MAKER_ADDRESS: getEnv('MARKET_MAKER_ADDRESS'),
    
    /** RPC URL for blockchain connection */
    RPC_URL: getEnv('RPC_URL', 'https://rpc.plumenetwork.xyz'),
    
    // ---------------------------------------------------------------------
    // Token & Chain Settings
    // ---------------------------------------------------------------------
    
    /** Supported chains by chain ID (default: Plume mainnet = 98866) */
    SUPPORTED_CHAINS: parseIntList(process.env.SUPPORTED_CHAINS, [98866]),
    
    /** 
     * Accepted token addresses for bidding/liquidation.
     * Use '*' to accept all tokens (not recommended for production).
     * @example "0x123...,0x456..."
     */
    ACCEPTED_TOKENS: parseList(process.env.ACCEPTED_TOKENS, ['*']),
    
    // ---------------------------------------------------------------------
    // Liquidation Settings
    // ---------------------------------------------------------------------
    
    LIQUIDATION: {
        /** Maximum portion of debt to liquidate (80% is typical max) */
        maxLiquidationRatio: parseFloat(process.env.LIQUIDATION_MAX_RATIO || '0.8'),
        /** Minimum health factor to consider liquidating */
        minHealthFactor: parseFloat(process.env.LIQUIDATION_MIN_HEALTH_FACTOR || '1.0'),
        /** Minimum profit margin required (as percentage) */
        minProfitMarginPercent: parseFloat(process.env.LIQUIDATION_MIN_PROFIT || '5'),
        /** Maximum gas price for liquidation txs */
        maxGasPriceGwei: parseFloat(process.env.LIQUIDATION_MAX_GAS_GWEI || '100'),
        /** Gas speed preference */
        gasSpeed: (process.env.LIQUIDATION_GAS_SPEED || 'fast') as LiquidationConfig['gasSpeed'],
        /** How long bids remain valid */
        bidExpiryMinutes: parseInt(process.env.LIQUIDATION_BID_EXPIRY_MIN || '20', 10),
    } as LiquidationConfig,
    
    // ---------------------------------------------------------------------
    // Bidding Settings
    // ---------------------------------------------------------------------
    
    BIDDING: {
        /** 
         * Price spread for quotes (0.98 = 2% market maker profit).
         * Lower spread = more competitive but lower profit.
         */
        priceSpread: parseFloat(process.env.PRICE_SPREAD || '0.98'),
        
        /** Minimum bid size to prevent dust transactions (in wei) */
        minBidAmountWei: process.env.MIN_BID_AMOUNT_WEI || '100',
        
        /** Whether to automatically approve tokens */
        autoApproveTokens: process.env.AUTO_APPROVE_TOKENS !== 'false',
        
        /** Maximum gas price for bidding txs */
        maxGasPriceGwei: parseFloat(process.env.BIDDING_MAX_GAS_GWEI || '50'),
        
        /** Gas speed preference */
        gasSpeed: (process.env.BIDDING_GAS_SPEED || 'standard') as BiddingConfig['gasSpeed'],
        
        /** Bid validity period */
        bidExpiryMinutes: parseInt(process.env.BIDDING_BID_EXPIRY_MIN || '60', 10),
    } as BiddingConfig,
    
    // ---------------------------------------------------------------------
    // Monitoring Settings
    // ---------------------------------------------------------------------
    
    MONITORING: {
        /** How often to poll for new RFQs */
        biddingPollIntervalMs: parseInt(process.env.BIDDING_POLL_INTERVAL_MS || '5000', 10),
        
        /** How often to check for liquidation opportunities */
        liquidationPollIntervalMs: parseInt(process.env.LIQUIDATION_POLL_INTERVAL_MS || '10000', 10),
        
        /** Max tracked items before memory cleanup */
        maxTrackedRequests: parseInt(process.env.MAX_TRACKED_REQUESTS || '1000', 10),
        
        /** Health check/reporting interval */
        healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '60000', 10),
    } as MonitoringConfig,
    
    // ---------------------------------------------------------------------
    // Risk Management
    // ---------------------------------------------------------------------
    
    RISK: {
        /** Maximum position size in USD (0 = unlimited) */
        maxPositionUsd: parseFloat(process.env.MAX_POSITION_USD || '0'),
        
        /** Maximum total exposure in USD (0 = unlimited) */
        maxTotalExposureUsd: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USD || '0'),
        
        /** Tokens to ignore (comma-separated addresses) */
        blacklistedTokens: parseList(process.env.BLACKLISTED_TOKENS, []),
        
        /** Require manual confirmation for large transactions */
        manualConfirmationThresholdUsd: parseFloat(process.env.MANUAL_CONFIRM_THRESHOLD_USD || '100000'),
    } as RiskManagementConfig,
    
    // ---------------------------------------------------------------------
    // Logging & Debugging
    // ---------------------------------------------------------------------
    
    /** 
     * Log level: 0=SILENT, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=TRACE
     * @see LogLevel enum in utils/logger.ts
     */
    LOG_LEVEL: parseInt(process.env.LOG_LEVEL || '3', 10) as LogLevel,
    
    /** Enable verbose API logging (may expose sensitive data) */
    DEBUG_API: process.env.DEBUG_API === 'true',
    
} as const;

// ============================================================================
// CONFIGURATION VALIDATION
// ============================================================================

export function validateConfig(): string[] {
    const errors: string[] = [];
    
    // Validate private key format
    if (!CONFIG.PRIVATE_KEY.match(/^0x[a-fA-F0-9]{64}$/)) {
        errors.push('PRIVATE_KEY must be a valid 64-character hex string with 0x prefix');
    }
    
    // Validate address format
    if (!CONFIG.MARKET_MAKER_ADDRESS.match(/^0x[a-fA-F0-9]{40}$/i)) {
        errors.push('MARKET_MAKER_ADDRESS must be a valid Ethereum address');
    }
    
    // Validate spread is reasonable
    if (CONFIG.BIDDING.priceSpread <= 0 || CONFIG.BIDDING.priceSpread > 1) {
        errors.push('PRICE_SPREAD must be between 0 and 1 (e.g., 0.98 = 98% of market price)');
    }
    
    // Validate liquidation ratio
    if (CONFIG.LIQUIDATION.maxLiquidationRatio <= 0 || CONFIG.LIQUIDATION.maxLiquidationRatio > 1) {
        errors.push('LIQUIDATION_MAX_RATIO must be between 0 and 1');
    }
    
    // Validate poll intervals aren't too aggressive
    if (CONFIG.MONITORING.biddingPollIntervalMs < 1000) {
        errors.push('BIDDING_POLL_INTERVAL_MS should be at least 1000ms to avoid rate limiting');
    }
    
    // Warn about wildcard token acceptance
    if (CONFIG.ACCEPTED_TOKENS[0] === '*') {
        console.warn('⚠️  ACCEPTED_TOKENS is set to "*" - accepting all tokens. This is risky for production.');
    }
    
    return errors;
}

// Run validation on module load
const validationErrors = validateConfig();
if (validationErrors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    validationErrors.forEach(err => console.error(`   - ${err}`));
    console.error('\nPlease check your .env file and environment variables.\n');
    process.exit(1);
}

// Log successful config load in non-test environments
if (process.env.NODE_ENV !== 'test') {
    console.log('✅ Configuration loaded successfully');
    console.log(`   Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);
    console.log(`   API Endpoint: ${CONFIG.API_BASE_URL}`);
    console.log(`   Chains: [${CONFIG.SUPPORTED_CHAINS.join(', ')}]`);
    console.log(`   Spread: ${(1 - CONFIG.BIDDING.priceSpread) * 100}%\n`);
}
