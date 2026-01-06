/**
 * Configuration loading and validation
 */

import * as dotenv from 'dotenv';
import { AppConfig, RawEnvConfig } from '../types';
import {
    ConfigValidationError,
    parseChains,
    parseTokens,
    parseBoolean,
    parseNumber,
    parseInt_,
    parseLogLevel,
    validateRequired,
    validateChains,
    validateSpread,
    validateAddress,
    validatePrivateKey,
    validateUrl,
} from './validation';

// Load .env file
dotenv.config();

function loadConfig(): AppConfig {
    const env = process.env as unknown as RawEnvConfig;
    const errors: string[] = [];

    // Parse values
    const supportedChains = parseChains(env.SUPPORTED_CHAINS || '98866');
    const priceSpread = parseNumber(env.PRICE_SPREAD, 0.98);
    const liquidationSpread = parseNumber(env.LIQUIDATION_SPREAD, 0.99);

    // Validate required fields
    const privateKeyError = validatePrivateKey(env.PRIVATE_KEY);
    if (privateKeyError) errors.push(privateKeyError);

    const addressError = validateAddress(env.MARKET_MAKER_ADDRESS, 'MARKET_MAKER_ADDRESS');
    if (addressError) errors.push(addressError);

    // Validate chains
    const chainsError = validateChains(supportedChains);
    if (chainsError) errors.push(chainsError);

    // Validate spreads
    const priceSpreadError = validateSpread(priceSpread, 'PRICE_SPREAD');
    if (priceSpreadError) errors.push(priceSpreadError);

    const liquidationSpreadError = validateSpread(liquidationSpread, 'LIQUIDATION_SPREAD');
    if (liquidationSpreadError) errors.push(liquidationSpreadError);

    // Validate URLs
    const rpcUrlError = validateUrl(env.RPC_URL || 'https://rpc.plume.org', 'RPC_URL');
    if (rpcUrlError) errors.push(rpcUrlError);

    const apiUrlError = validateUrl(env.API_BASE_URL || 'https://api.mysticfinance.xyz', 'API_BASE_URL');
    if (apiUrlError) errors.push(apiUrlError);

    // Validate optional Slack URL if enabled
    const slackEnabled = parseBoolean(env.SLACK_ENABLED, false);
    if (slackEnabled) {
        const slackUrlError = validateUrl(env.SLACK_WEBHOOK_URL, 'SLACK_WEBHOOK_URL');
        if (slackUrlError) errors.push(slackUrlError);
    }

    // Validate optional WebSocket URL if enabled
    const wsEnabled = parseBoolean(env.WS_ENABLED, false);
    if (wsEnabled) {
        const wsUrlError = validateUrl(env.WS_URL, 'WS_URL');
        if (wsUrlError) errors.push(wsUrlError);
    }

    // Throw if there are validation errors
    if (errors.length > 0) {
        throw new ConfigValidationError(errors);
    }

    return {
        // API Configuration
        apiBaseUrl: env.API_BASE_URL || 'https://api.mysticfinance.xyz',
        apiKey: env.MARKET_MAKER_API_KEY || '',

        // Wallet Configuration
        privateKey: env.PRIVATE_KEY!,
        marketMakerAddress: env.MARKET_MAKER_ADDRESS!,
        rpcUrl: env.RPC_URL || 'https://rpc.plume.org',

        // Strategy Settings
        acceptedTokens: parseTokens(env.ACCEPTED_TOKENS),
        priceSpread,
        liquidationSpread,
        minBidAmountWei: env.MIN_BID_AMOUNT_WEI || '100',
        supportedChains,

        // Poll Intervals
        biddingPollIntervalMs: parseInt_(env.BIDDING_POLL_INTERVAL_MS, 5000),
        liquidationPollIntervalMs: parseInt_(env.LIQUIDATION_POLL_INTERVAL_MS, 10000),

        // Notifications
        slackWebhookUrl: env.SLACK_WEBHOOK_URL || '',
        slackEnabled,

        // Feature Flags
        enableBidding: parseBoolean(env.ENABLE_BIDDING, true),
        enableLiquidations: parseBoolean(env.ENABLE_LIQUIDATIONS, true),

        // Health Check
        minEthBalanceWei: env.MIN_ETH_BALANCE_WEI || '10000000000000000', // 0.01 ETH

        // Logging
        logLevel: parseLogLevel(env.LOG_LEVEL),

        // WebSocket
        wsEnabled,
        wsUrl: env.WS_URL || '',
        wsReconnectIntervalMs: parseInt_(env.WS_RECONNECT_INTERVAL_MS, 5000),
    };
}

// Export singleton config
export const config = loadConfig();

// Re-export validation utilities
export { ConfigValidationError } from './validation';
