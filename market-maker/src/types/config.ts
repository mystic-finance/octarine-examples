/**
 * Application configuration type definitions
 */

export interface AppConfig {
    // API Configuration
    apiBaseUrl: string;
    apiKey: string;

    // Wallet Configuration
    privateKey: string;
    marketMakerAddress: string;
    rpcUrl: string;

    // Strategy Settings
    acceptedTokens: string[];
    priceSpread: number;
    liquidationSpread: number;
    minBidAmountWei: string;
    supportedChains: number[];

    // Poll Intervals
    biddingPollIntervalMs: number;
    liquidationPollIntervalMs: number;

    // Notifications
    slackWebhookUrl: string;
    slackEnabled: boolean;

    // Feature Flags
    enableBidding: boolean;
    enableLiquidations: boolean;

    // Health Check
    minEthBalanceWei: string;

    // Logging
    logLevel: LogLevel;

    // WebSocket
    wsEnabled: boolean;
    wsUrl: string;
    wsReconnectIntervalMs: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RawEnvConfig {
    API_BASE_URL?: string;
    MARKET_MAKER_API_KEY?: string;
    PRIVATE_KEY?: string;
    MARKET_MAKER_ADDRESS?: string;
    RPC_URL?: string;
    ACCEPTED_TOKENS?: string;
    PRICE_SPREAD?: string;
    LIQUIDATION_SPREAD?: string;
    MIN_BID_AMOUNT_WEI?: string;
    SUPPORTED_CHAINS?: string;
    BIDDING_POLL_INTERVAL_MS?: string;
    LIQUIDATION_POLL_INTERVAL_MS?: string;
    SLACK_WEBHOOK_URL?: string;
    SLACK_ENABLED?: string;
    ENABLE_BIDDING?: string;
    ENABLE_LIQUIDATIONS?: string;
    MIN_ETH_BALANCE_WEI?: string;
    LOG_LEVEL?: string;
    WS_ENABLED?: string;
    WS_URL?: string;
    WS_RECONNECT_INTERVAL_MS?: string;
}
