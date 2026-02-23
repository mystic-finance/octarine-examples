/**
 * Instant Redemption Bidding Engine
 * 
 * This module handles the Request-for-Quote (RFQ) bidding process where market makers
 * compete to provide liquidity for user redemption requests. Market makers sign 
 * 0x Limit Orders that allow users to swap their rwa tokens for redemption assets.
 * 
 * ## How RFQ Bidding Works
 * 
 * 1. **User Request**: User wants to redeem RWA tokens for stablecoins
 * 2. **RFQ Created**: Octarine creates an RFQ request and broadcasts to market makers
 * 3. **Market Maker Bids**: Market makers submit signed 0x Limit Orders with their quotes
 * 4. **Best Bid Wins**: The user selects the best quote (or auto-selected)
 * 5. **Settlement**: The winning market maker receives RWA, user receives stablecoins
 * 
 * ## Key Concepts
 * 
 * - **LimitOrder**: A 0x protocol order type allowing makers to specify exact pricing
 * - **Spread**: The difference between market price and your quote (your profit margin)
 * - **Expiry**: How long your bid remains valid
 * - **Transform**: The final settlement transaction after winning a bid
 * 
 * @see https://0x.org/docs for 0x protocol details
 * @see https://docs.mysticfinance.xyz for Octarine protocol specifics
 */

import { LimitOrder, SignatureType } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import { ethers, Wallet } from 'ethers';
import axios from 'axios';
import { approveTokenToExchangeProxy } from './approvals';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { retry, CircuitBreaker } from './utils/retry';
import { calculateGasParams, isProfitableAfterGas, GasStrategy } from './utils/gas';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * An RFQ (Request for Quote) represents a user's redemption request
 * waiting for market maker bids.
 */
interface RFQRequest {
    /** Unique request identifier */
    requestId: string;
    /** User's wallet address */
    user: string;
    /** Token user is giving (market maker receives) - typically RWA */
    redeemAsset: string;
    /** Token user wants (market maker provides) - typically stablecoin */
    redemptionAsset: string;
    /** Amount of redeemAsset the user is offering */
    redeemAmount: string;
    /** Blockchain chain ID */
    chainId: number;
    /** Current status of the request */
    status: 'Pending' | 'Bidding' | 'Solved' | 'Cancelled';
    /** Unix timestamp when request expires */
    expiry: number;
    /** Additional order information from the protocol */
    metadata?: {
        rfqOrder?: RFQOrderFromMetadata;
    };
    /** ISO timestamp when request was created */
    createdAt: string;
}

/**
 * The 0x Limit Order structure provided by the Octarine API.
 * This is populated with the user's side of the trade; 
 * market makers fill in their quote (makerAmount).
 */
interface RFQOrderFromMetadata {
    chainId: number;
    verifyingContract: string;  // The 0x Exchange Proxy
    makerToken: string;         // What market maker provides
    takerToken: string;         // What user provides
    takerAmount: string;        // Amount user will give
    taker: string;              // User's address
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: number;
    salt: number;
}

/**
 * EIP-712 signature components
 */
interface Signature {
    signatureType: number;
    v: number;
    r: string;
    s: string;
}

/**
 * Request body for submitting a bid to the Octarine API
 */
interface SubmitBidRequest {
    requestId: string;
    maker: string;
    makerAmount: string;
    expiry: number;
    signature: Signature;
    /** Unix timestamp when bid becomes active (0 = immediately) */
    activeFrom?: number;
}

// ============================================================================
// CIRCUIT BREAKER FOR API RESILIENCE
// ============================================================================

/** Circuit breaker to prevent overwhelming the API during issues */
const apiCircuitBreaker = new CircuitBreaker(5, 60000);

// ============================================================================
// BID STATUS TRACKING
// ============================================================================

/** Simple bid statistics tracker */
const redemptionBidStats = {
    accepted: 0,
    pending: 0,
    failed: 0,
    total: 0,
    lastLogged: 0,
};

/**
 * Fetch bid status from API
 * @see https://curator-api.mysticfinance.xyz/docs/#/Octarine/OctarineController_getBid
 */
async function checkRedemptionBidStatus(bidId: string): Promise<string | null> {
    try {
        const response = await axios.get(
            `${CONFIG.API_BASE_URL}/octarine/bid/${bidId}`,
            {
                headers: CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {},
                timeout: 5000,
            }
        );
        return response.data.data?.status || null;
    } catch {
        return null;
    }
}

/** Log bid statistics periodically */
function logRedemptionBidStats(): void {
    const now = Date.now();
    if (now - redemptionBidStats.lastLogged < 60000) return; // Log every 60s

    redemptionBidStats.lastLogged = now;
    console.log(`[Redemption Bids] Total: ${redemptionBidStats.total}, Accepted: ${redemptionBidStats.accepted}, Pending: ${redemptionBidStats.pending}, Failed: ${redemptionBidStats.failed}`);
}

// ============================================================================
// STEP 1: FETCH PENDING RFQ REQUESTS
// ============================================================================

/**
 * Fetch all pending RFQ requests from the Octarine API.
 * These are opportunities where users are waiting for market maker quotes.
 * 
 * @returns Array of pending RFQ requests
 */
async function getPendingRequests(): Promise<RFQRequest[]> {
    return retry(
        async () => {
            console.log(CONFIG)
            const response = await axios.get(
                `${CONFIG.API_BASE_URL}/octarine/requests`,
                {
                    params: {
                        status: 'pending,bidding',
                        marketMaker: CONFIG.MARKET_MAKER_ADDRESS,
                    },
                    headers: CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {},
                    timeout: 10000,
                },
            );

            const requests = response.data.data || [];
            logger.info(`Fetched ${requests.length} pending RFQ requests`, {
                count: requests.length,
            });

            return requests;
        },
        {
            maxRetries: 3,
            context: { operation: 'getPendingRequests' },
            onRetry: (attempt, error, delay) => {
                logger.warn(`Retrying fetch pending requests (attempt ${attempt})`, {
                    delayMs: delay,
                    error: error.message,
                });
            },
        }
    );
}

// ============================================================================
// STEP 2: SIGN LIMIT ORDER
// ============================================================================

/**
 * Create and sign a 0x Limit Order for an RFQ request.
 * 
 * The market maker signs an order offering `makerAmount` of `makerToken`
 * in exchange for the user's `takerAmount` of `takerToken`.
 * 
 * @param rfqRequest - The RFQ request from the API
 * @param makerAmount - The market maker's quote amount (what they'll provide)
 * @returns The signed order and signature components
 */
async function signRFQOrder(
    rfqRequest: RFQRequest,
    makerAmount: string,
): Promise<{ order: any; signature: Signature }> {
    logger.debug(`Signing order for request ${rfqRequest.requestId}`, {
        requestId: rfqRequest.requestId,
        makerAmount,
    });

    const base = rfqRequest?.metadata?.rfqOrder;
    if (!base) {
        throw new Error(`Missing metadata.rfqOrder in RFQ request ${rfqRequest.requestId}`);
    }

    try {
        // Create a 0x LimitOrder with the market maker's quote
        const order = new LimitOrder({
            chainId: base.chainId,
            verifyingContract: base.verifyingContract,
            makerToken: base.makerToken,
            takerToken: base.takerToken,
            makerAmount: new BigNumber(makerAmount),
            takerAmount: new BigNumber(base.takerAmount),
            maker: CONFIG.MARKET_MAKER_ADDRESS,
            taker: base.taker,
            pool: base.pool,
            sender: base.sender,
            feeRecipient: base.feeRecipient,
            takerTokenFeeAmount: new BigNumber(String(base.takerTokenFeeAmount)),
            expiry: new BigNumber(base.expiry),
            salt: new BigNumber(base.salt),
        });

        // Sign with the market maker's private key using EIP-712
        const wallet = new Wallet(CONFIG.PRIVATE_KEY);
        const signature = await order.getSignatureWithKey(
            wallet.privateKey,
            SignatureType.EIP712,
        );

        logger.success('Order signed successfully', 0, {
            requestId: rfqRequest.requestId,
            makerAmount,
            expiry: base.expiry,
        });

        return {
            order: {
                chainId: order.chainId,
                verifyingContract: order.verifyingContract,
                makerToken: order.makerToken,
                takerToken: order.takerToken,
                makerAmount: order.makerAmount.toString(),
                takerAmount: order.takerAmount.toString(),
                maker: order.maker,
                taker: order.taker,
                pool: order.pool,
                sender: order.sender,
                feeRecipient: order.feeRecipient,
                takerTokenFeeAmount: order.takerTokenFeeAmount.toString(),
                expiry: order.expiry.toString(),
                salt: order.salt.toString(),
            },
            signature,
        };
    } catch (error: any) {
        logger.error(
            `Failed to sign order for ${rfqRequest.requestId}`,
            { requestId: rfqRequest.requestId },
            error
        );
        throw error;
    }
}

// ============================================================================
// STEP 3: SUBMIT BID TO API
// ============================================================================

/**
 * Submit a signed bid to the Octarine API.
 * This enters the market maker into the auction for this RFQ.
 * 
 * @param params - Bid submission parameters including signature
 * @returns API response with bidId
 */
async function submitBid(params: SubmitBidRequest): Promise<any> {
    logger.debug(`Submitting bid for request ${params.requestId}`, {
        requestId: params.requestId,
        makerAmount: params.makerAmount,
    });

    return retry(
        async () => {
            const response = await axios.post(
                `${CONFIG.API_BASE_URL}/octarine/bid`,
                params,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {}),
                    },
                    timeout: 15000,
                },
            );

            logger.success(`Bid submitted for ${params.requestId}`, 0, {
                requestId: params.requestId,
                bidId: response.data.data?.bidId,
            });

            return response.data;
        },
        {
            maxRetries: 3,
            context: { operation: 'submitBid', requestId: params.requestId },
        }
    );
}

// ============================================================================
// PRICING LOGIC
// ============================================================================

/**
 * Calculate the market maker's quote amount based on their pricing strategy.
 * 
 * The formula: `quote = takerAmount * priceSpread`
 * 
 * Example: User offers 1000 RWA tokens, spread = 0.98
 * Quote = 1000 * 0.98 = 980 stablecoins offered by market maker
 * Market maker profit = 1000 - 980 = 20 tokens (2% spread)
 * 
 * @param request - The RFQ request
 * @returns The quote amount in wei (as string)
 */
function calculateQuote(request: RFQRequest): string {
    const takerAmount = new BigNumber(request.redeemAmount);
    const spread = CONFIG.BIDDING.priceSpread;

    // Apply spread to determine maker amount
    const quote = takerAmount.multipliedBy(spread).integerValue(BigNumber.ROUND_DOWN);

    // Calculate potential profit for logging
    const profit = takerAmount.minus(quote);
    const profitPercent = (1 - spread) * 100;

    logger.debug(`Calculated quote for ${request.requestId}`, {
        requestId: request.requestId,
        redeemAmountWei: request.redeemAmount,
        quoteAmountWei: quote.toString(),
        spreadPercent: profitPercent,
        profitWei: profit.toString(),
    });

    return quote.toString();
}

/**
 * Determine if the market maker should bid on this request.
 * 
 * Filtering criteria:
 * 1. Token is in the accepted tokens list
 * 2. Amount meets minimum threshold
 * 3. Chain is supported
 * 4. Request has sufficient time remaining
 * 5. Token is not blacklisted
 * 
 * @param request - The RFQ request to evaluate
 * @returns True if the market maker should bid
 */
function shouldBidOnRequest(request: RFQRequest): boolean {
    const context = { requestId: request.requestId };

    // 1. Check if token is blacklisted
    if (CONFIG.RISK.blacklistedTokens.length > 0) {
        const isBlacklisted = CONFIG.RISK.blacklistedTokens.some(
            t => t.toLowerCase() === request.redeemAsset.toLowerCase()
        );
        if (isBlacklisted) {
            logger.debug(`Skipping blacklisted token`, { ...context, token: request.redeemAsset });
            return false;
        }
    }

    // 2. Check supported tokens whitelist
    if (CONFIG.ACCEPTED_TOKENS[0] !== '*') {
        const redeemAsset = request.redeemAsset.toLowerCase();
        const isSupported = CONFIG.ACCEPTED_TOKENS.some(
            t => t.toLowerCase() === redeemAsset
        );
        if (!isSupported) {
            logger.debug(`Skipping unsupported token`, { ...context, token: request.redeemAsset });
            return false;
        }
    }

    // 3. Check minimum amount (prevents dust transactions)
    const minAmount = new BigNumber(CONFIG.BIDDING.minBidAmountWei);
    if (new BigNumber(request.redeemAmount).isLessThan(minAmount)) {
        logger.debug(`Skipping: amount below minimum`, {
            ...context,
            amount: request.redeemAmount,
            minRequired: CONFIG.BIDDING.minBidAmountWei,
        });
        return false;
    }

    // 4. Check chain support
    if (!CONFIG.SUPPORTED_CHAINS.includes(request.chainId)) {
        logger.debug(`Skipping: unsupported chain`, {
            ...context,
            chainId: request.chainId,
            supportedChains: CONFIG.SUPPORTED_CHAINS,
        });
        return false;
    }

    // 5. Check request hasn't expired
    const now = Math.floor(Date.now() / 1000);
    const timeLeft = request.expiry - now;
    if (timeLeft < 60) { // Less than 60 seconds remaining
        logger.debug(`Skipping: expiring soon`, { ...context, timeLeftSeconds: timeLeft });
        return false;
    }

    return true;
}

// ============================================================================
// BALANCE CHECKS
// ============================================================================

const ERC20_BALANCE_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

/**
 * Check if the market maker has sufficient balance to fulfill a bid.
 * 
 * @param makerToken - Token the market maker needs to provide
 * @param makerAmount - Amount needed
 * @param wallet - Ethers wallet to check
 * @returns True if balance is sufficient
 */
async function checkSufficientBalance(
    makerToken: string,
    makerAmount: string,
    wallet: Wallet,
): Promise<boolean> {
    try {
        const tokenContract = new ethers.Contract(makerToken, ERC20_BALANCE_ABI, wallet);

        const [balance, decimals, symbol] = await Promise.all([
            tokenContract.balanceOf(wallet.address),
            tokenContract.decimals().catch(() => 18),
            tokenContract.symbol().catch(() => 'UNKNOWN'),
        ]);

        const requiredAmount = ethers.BigNumber.from(makerAmount);

        if (balance.lt(requiredAmount)) {
            logger.warn(`Insufficient balance for ${symbol}`, {
                token: symbol,
                required: ethers.utils.formatUnits(requiredAmount, decimals),
                available: ethers.utils.formatUnits(balance, decimals),
                decimals,
            });
            return false;
        }

        logger.debug(`Balance check passed for ${symbol}`, {
            token: symbol,
            balance: ethers.utils.formatUnits(balance, decimals),
            required: ethers.utils.formatUnits(requiredAmount, decimals),
        });

        return true;
    } catch (error: any) {
        logger.error(`Failed to check balance`, { makerToken }, error);
        return false;
    }
}

// ============================================================================
// MAIN BIDDING FLOW
// ============================================================================

/**
 * Process a single RFQ request end-to-end:
 * 1. Validate the request
 * 2. Calculate quote
 * 3. Check balance
 * 4. Approve token if needed
 * 5. Sign the order
 * 6. Submit the bid
 */
async function processSingleRequest(
    request: RFQRequest,
    wallet: Wallet,
    provider: ethers.providers.Provider
): Promise<void> {
    const context = { requestId: request.requestId };

    try {
        logger.debug(`Processing RFQ request`, context);

        // Skip if we shouldn't bid on this request
        if (!shouldBidOnRequest(request)) {
            return;
        }

        const makerAmount = calculateQuote(request);

        // Extract contract info from metadata
        const verifyingContract = request.metadata?.rfqOrder?.verifyingContract;
        const makerToken = request.metadata?.rfqOrder?.makerToken;

        if (!verifyingContract || !makerToken) {
            logger.error(`Missing order metadata`, context);
            return;
        }

        // Check balance
        const hasSufficientBalance = await checkSufficientBalance(
            makerToken,
            makerAmount,
            wallet
        );
        if (!hasSufficientBalance) {
            logger.debug(`Skipping: insufficient balance`, context);
            return;
        }

        // Approve token if needed
        await approveTokenToExchangeProxy(
            verifyingContract,
            makerAmount,
            makerToken,
            wallet
        );

        // Sign the limit order
        const { signature } = await signRFQOrder(request, makerAmount);

        // Calculate bid expiry (relative to now)
        const bidExpirySeconds = CONFIG.BIDDING.bidExpiryMinutes * 60;

        // Submit the bid
        const response = await submitBid({
            requestId: request.requestId,
            maker: CONFIG.MARKET_MAKER_ADDRESS,
            makerAmount,
            expiry: bidExpirySeconds,
            signature,
            activeFrom: 0, // Active immediately
        });

        // Track bid status
        const bidId = response?.bidId || response?.data?.bidId;
        if (bidId) {
            redemptionBidStats.total++;
            redemptionBidStats.pending++;

            // Check status asynchronously
            setTimeout(async () => {
                const status = await checkRedemptionBidStatus(bidId);
                if (status) {
                    redemptionBidStats.pending--;
                    if (status === 'accepted') redemptionBidStats.accepted++;
                    else if (status === 'failed') redemptionBidStats.failed++;
                }
            }, 5000);
        }

        logger.success(`Successfully bid on ${request.requestId}`, 0, context);

    } catch (error: any) {
        logger.error(`Failed to process request ${request.requestId}`, context, error);
    }
}

/**
 * Delay utility for polling intervals
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MAIN BIDDING LOOP
// ============================================================================

/**
 * Start the continuous bidding loop.
 * This runs indefinitely, polling for new RFQ requests and submitting bids.
 */
export async function startBiddingLoop(): Promise<void> {
    logger.info('🚀 Starting Instant Redemption Bidding Bot');
    logger.info('==========================================');
    logger.info(`Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);
    logger.info(`Spread: ${(1 - CONFIG.BIDDING.priceSpread) * 100}%`);
    logger.info(`Min Bid: ${CONFIG.BIDDING.minBidAmountWei} wei`);
    logger.info(`Chains: [${CONFIG.SUPPORTED_CHAINS.join(', ')}]`);
    logger.info('==========================================\n');

    // Track processed requests to avoid re-bidding
    const processedRequests = new Set<string>();

    // Setup wallet and provider
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);

    while (true) {
        const loopStart = Date.now();

        try {
            // 1. Fetch pending RFQ requests
            const requests = await getPendingRequests();

            // 2. Process each request
            for (const request of requests) {
                if (processedRequests.has(request.requestId)) {
                    continue;
                }

                await processSingleRequest(request, wallet, provider);
                processedRequests.add(request.requestId);
            }

            // 3. Memory management - clean up old entries
            if (processedRequests.size > CONFIG.MONITORING.maxTrackedRequests) {
                const requestIds = Array.from(processedRequests);
                if (requestIds.length > CONFIG.MONITORING.maxTrackedRequests / 2) {
                    const toRemove = requestIds.slice(0, Math.floor(requestIds.length / 2));
                    toRemove.forEach(id => processedRequests.delete(id));
                    logger.debug(`Cleaned up ${toRemove.length} old request entries`);
                }
            }

        } catch (error: any) {
            logger.error('Error in bidding loop', {}, error);
        }

        // Log bid statistics periodically
        logRedemptionBidStats();

        // Calculate time to next poll
        const elapsed = Date.now() - loopStart;
        const remainingDelay = Math.max(0, CONFIG.MONITORING.biddingPollIntervalMs - elapsed);

        if (remainingDelay > 0) {
            logger.trace(`Waiting ${remainingDelay}ms until next poll`);
            await delay(remainingDelay);
        }
    }
}

// Entry point for standalone execution
if (require.main === module) {
    startBiddingLoop().catch((error) => {
        logger.error('Bidding bot crashed', {}, error);
        process.exit(1);
    });
}
