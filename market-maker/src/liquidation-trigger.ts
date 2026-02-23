/**
 * Liquidation Trigger Engine
 * 
 * This module monitors for underwater positions in the Octarine protocol and 
 * triggers liquidations to earn liquidation bonuses. When a borrower's health 
 * factor drops below 1.0, their position becomes eligible for liquidation.
 * 
 * ## How Liquidations Work in Octarine
 * 
 * 1. **Borrower Position**: Users deposit collateral and borrow against it
 * 2. **Health Factor**: Ratio of collateral value to borrowed value
 *    - HF > 1.0: Position is healthy
 *    - HF < 1.0: Position can be liquidated
 * 3. **Liquidation Opportunity**: Market maker repays part of the debt
 *    and receives a bonus amount of collateral
 * 4. **Profit**: The bonus collateral is worth more than the debt repaid
 * 
 * ## Liquidation Bonus Math
 * 
 * Typical liquidation bonus: 5-10% depending on the asset
 * 
 * Example:
 * - Debt to repay: 1000 USDC
 * - Collateral seized: 1050 USD worth of ETH (with 5% bonus)
 * - Gross profit: 50 USD worth of ETH
 * - Net profit: 50 USD minus gas costs
 * 
 * ## Key Considerations
 * 
 * - **Gas Costs**: High gas can erase small liquidation profits
 * - **Price Volatility**: Collateral value can drop during settlement
 * - **MEV Competition**: Liquidations are competitive; speed matters
 * - **Partial Liquidations**: Can liquidate up to 50% of position at once
 * 
 * @see https://docs.mysticfinance.xyz/liquidations for protocol specifics
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
 * A liquidation opportunity in the protocol
 */
interface Liquidation {
    /** Unique liquidation ID */
    _id: string;
    /** Market identifier (pool + collateral + debt) */
    marketId: string;
    /** Borrower whose position is being liquidated */
    borrower: string;
    /** Token used as collateral */
    collateralAsset: string;
    /** Token being borrowed (debt) */
    debtAsset: string;
    /** Total collateral in the position */
    collateralAmount: string;
    /** Total debt in the position */
    borrowedAmount: string;
    /** Maximum collateral seizable (usually 50% or less) */
    collateralAmountThatCanBeSeized: string;
    /** Health factor of the position (< 1.0 = liquidatable) */
    healthFactor: number;
    /** Chain ID where the position exists */
    chainId: number;
    /** Current status of the liquidation */
    status: 'pending' | 'processing' | 'completed' | 'failed';
    /** The 0x Exchange Proxy address for this chain */
    exchangeProxy: string;
    /** Current price of collateral in terms of debt token */
    baseFeedPrice: number;
    /** Debt token metadata */
    borrowedPosition: {
        asset: {
            id: string;
            decimals: number;
            name: string;
            symbol: string;
        };
    };
    /** Collateral token metadata */
    collateralPosition: {
        asset: {
            id: string;
            decimals: number;
            name: string;
            symbol: string;
        };
    };
}

/**
 * 0x Limit Order structure for liquidation
 */
interface LiquidationOrderInfo {
    chainId: number;
    verifyingContract: string;
    makerToken: string;      // Debt token (what we pay)
    takerToken: string;      // Collateral token (what we receive)
    takerAmount: string;     // Collateral to seize
    makerAmount: string;     // Debt to repay
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: number;
    salt: string;
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
 * Request body for triggering a liquidation via API
 */
interface TriggerLiquidationRequest {
    liquidationId: string;
    marketMaker: string;
    signature: Signature;
    debtAmountToLiquidate: number;
    orderInfo: any;
    expiry: number;
}

/**
 * Calculated amounts for a liquidation
 */
interface LiquidationAmounts {
    debtToRepay: string;      // In wei, normalized to debt token decimals
    collateralToSeize: string; // In wei, normalized to collateral token decimals
    profitWei: string;        // Estimated profit in wei
    debtDecimals: number;
    collateralDecimals: number;
}

// ============================================================================
// CIRCUIT BREAKER FOR API RESILIENCE
// ============================================================================

/** Circuit breaker for liquidation API calls */
const liquidationCircuitBreaker = new CircuitBreaker(5, 60000);

// ============================================================================
// BID STATUS TRACKING
// ============================================================================

/** Simple bid statistics tracker */
const liquidationBidStats = {
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
async function checkLiquidationBidStatus(bidId: string): Promise<string | null> {
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
function logLiquidationBidStats(): void {
    const now = Date.now();
    if (now - liquidationBidStats.lastLogged < 60000) return; // Log every 60s

    liquidationBidStats.lastLogged = now;
    console.log(`[Liquidation Bids] Total: ${liquidationBidStats.total}, Accepted: ${liquidationBidStats.accepted}, Pending: ${liquidationBidStats.pending}, Failed: ${liquidationBidStats.failed}`);
}

// ============================================================================
// STEP 1: FETCH LIQUIDATION OPPORTUNITIES
// ============================================================================

/**
 * Fetch open liquidation opportunities from the Octarine API.
 * 
 * Filters can be applied via configuration:
 * - Chain ID (typically just one chain per bot instance)
 * - Collateral assets (whitelist)
 * 
 * @returns Array of liquidatable positions
 */
async function getOpenLiquidations(): Promise<Liquidation[]> {
    return retry(
        async () => {
            const params: Record<string, any> = {
                chainId: CONFIG.SUPPORTED_CHAINS[0],
                limit: 1000,
            };

            // Filter by accepted collateral assets if configured
            if (CONFIG.ACCEPTED_TOKENS.length > 0 && CONFIG.ACCEPTED_TOKENS[0] !== '*') {
                params.collateralAssets = CONFIG.ACCEPTED_TOKENS.join(',');
            }

            const response = await axios.get(
                `${CONFIG.API_BASE_URL}/octarine/liquidations/opportunities`,
                {
                    params,
                    headers: CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {},
                    timeout: 15000,
                },
            );

            const liquidations = response.data.data || [];
            logger.info(`Found ${liquidations.length} liquidation opportunities`, {
                count: liquidations.length,
                chainId: params.chainId,
            });

            return liquidations;
        },
        {
            maxRetries: 3,
            initialDelayMs: 2000,
            context: { operation: 'getOpenLiquidations' },
        }
    );
}

// ============================================================================
// STEP 2: CALCULATE LIQUIDATION AMOUNTS
// ============================================================================

/**
 * Calculate optimal liquidation amounts for a position.
 * 
 * The goal is to maximize profit while staying within protocol limits.
 * Most protocols allow liquidating up to 50% of an underwater position.
 * 
 * @param liquidation - The liquidation opportunity
 * @returns Calculated amounts for debt repayment and collateral seizure
 */
function calculateLiquidationAmounts(liquidation: Liquidation): LiquidationAmounts {
    const debtAmount = new BigNumber(liquidation.borrowedAmount);
    const maxSeizable = new BigNumber(liquidation.collateralAmountThatCanBeSeized || 0);

    const decimals = liquidation.borrowedPosition.asset.decimals ?? 18;
    const collateralDecimals = liquidation.collateralPosition.asset.decimals ?? 18;

    // No seizable collateral means we can't liquidate
    if (maxSeizable.isZero()) {
        logger.debug(`No collateral available for seizure`, { liquidationId: liquidation._id });
        return {
            debtToRepay: '0',
            collateralToSeize: '0',
            profitWei: '0',
            debtDecimals: decimals,
            collateralDecimals,
        };
    }

    // Use configured max liquidation ratio (typically 50-80%)
    const maxRatio = CONFIG.LIQUIDATION.maxLiquidationRatio;

    // Calculate amounts based on max ratio
    const debtToRepay = debtAmount.multipliedBy(maxRatio);
    const collateralToSeize = maxSeizable.multipliedBy(maxRatio);

    // Rough profit estimation (actual profit depends on oracle prices and bonus)
    // This assumes we seize more collateral value than debt repaid
    const profitWei = collateralToSeize.minus(debtToRepay);

    logger.trace(`Calculated liquidation amounts for ${liquidation._id}`, {
        liquidationId: liquidation._id,
        debtToRepay: debtToRepay.toString(),
        collateralToSeize: collateralToSeize.toString(),
        estimatedProfit: profitWei.toString(),
    });

    return {
        debtToRepay: debtToRepay
            .multipliedBy(10 ** decimals)
            .integerValue(BigNumber.ROUND_DOWN)
            .toString(),
        collateralToSeize: collateralToSeize
            .multipliedBy(10 ** collateralDecimals)
            .integerValue(BigNumber.ROUND_DOWN)
            .toString(),
        profitWei: profitWei.toString(),
        debtDecimals: decimals,
        collateralDecimals,
    };
}

/**
 * Calculate the maker amount (debt to repay) based on collateral value.
 * 
 * This creates a competitive quote that includes the liquidation bonus.
 * The protocol rewards liquidators with bonus collateral, so we compete
 * on how much of that bonus we capture versus other liquidators.
 * 
 * @param collateralToSeize - Amount of collateral to receive
 * @param baseFeedPrice - Price ratio (collateral / debt)
 * @param collateralDecimals - Decimals of collateral token
 * @param debtDecimals - Decimals of debt token
 * @returns Maker amount string in wei
 */
function calculateQuote(
    collateralToSeize: string,
    baseFeedPrice: number,
    collateralDecimals: number,
    debtDecimals: number,
): string {
    const collateralAmount = new BigNumber(collateralToSeize);

    // Convert collateral value to debt token terms
    // baseFeedPrice = collateralPrice / debtPrice
    // debtValue = collateralAmount * baseFeedPrice (adjusted for decimals)
    const decimalAdjustment = 10 ** (debtDecimals - collateralDecimals);
    const debtValue = collateralAmount
        .multipliedBy(baseFeedPrice)
        .multipliedBy(decimalAdjustment);

    // Apply spread to be competitive (higher = more aggressive, lower profit)
    // Default 0.99 means we ask for 99% of theoretical value (1% profit margin)
    const spread = 0.99;
    const quote = debtValue.multipliedBy(spread).integerValue(BigNumber.ROUND_DOWN);

    return quote.toFixed(0);
}

// ============================================================================
// STEP 3: BUILD & SIGN LIQUIDATION ORDER
// ============================================================================

/**
 * Build the 0x Limit Order for liquidation.
 * 
 * The liquidation order differs from RFQ orders:
 * - We (maker) provide debt tokens to repay borrower's loan
 * - We receive collateral tokens with a liquidation bonus
 * - The taker is the protocol/anyone, not a specific user
 * 
 * @param liquidation - The liquidation opportunity
 * @param amounts - Calculated liquidation amounts
 * @returns Order info structure
 */
function buildLiquidationOrderInfo(
    liquidation: Liquidation,
    amounts: LiquidationAmounts,
): LiquidationOrderInfo {
    const salt = Date.now().toString();

    // Calculate expiry based on configuration
    const expiryMinutes = CONFIG.LIQUIDATION.bidExpiryMinutes;
    const expiry = Math.floor(Date.now() / 1000) + (expiryMinutes * 60);

    // Calculate the debt amount we need to provide
    const makerAmount = calculateQuote(
        amounts.collateralToSeize,
        liquidation.baseFeedPrice,
        amounts.collateralDecimals,
        amounts.debtDecimals,
    );

    logger.trace(`Built liquidation order info for ${liquidation._id}`, {
        liquidationId: liquidation._id,
        makerAmount,
        takerAmount: amounts.collateralToSeize,
        expiry,
    });

    return {
        chainId: liquidation.chainId,
        verifyingContract: liquidation.exchangeProxy,
        makerToken: liquidation.borrowedPosition.asset.id,  // Debt token (we pay)
        takerToken: liquidation.collateralAsset,             // Collateral (we receive)
        makerAmount,
        takerAmount: amounts.collateralToSeize,
        pool: '0x0000000000000000000000000000000000000000000000000000000000000000',
        sender: '0x0000000000000000000000000000000000000000',
        feeRecipient: '0x0000000000000000000000000000000000000000',
        takerTokenFeeAmount: '0',
        expiry,
        salt,
    };
}

/**
 * Sign a liquidation order with the market maker's private key.
 * 
 * @param orderInfo - The order to sign
 * @returns Signed order and signature components
 */
async function signLiquidationOrder(
    orderInfo: LiquidationOrderInfo,
): Promise<{ order: any; signature: Signature }> {
    logger.debug('Signing liquidation order', {
        makerAmount: orderInfo.makerAmount,
        takerAmount: orderInfo.takerAmount,
    });

    try {
        // Add safety buffer to amounts (protocol expects these bounds)
        const makerAmount = new BigNumber(orderInfo.makerAmount)
            .multipliedBy(1.01)
            .integerValue(BigNumber.ROUND_DOWN);
        const takerAmount = new BigNumber(orderInfo.takerAmount)
            .multipliedBy(1.01)
            .integerValue(BigNumber.ROUND_DOWN);

        const order = new LimitOrder({
            chainId: orderInfo.chainId,
            verifyingContract: orderInfo.verifyingContract,
            maker: CONFIG.MARKET_MAKER_ADDRESS,
            taker: '0x0000000000000000000000000000000000000000', // Any taker
            makerToken: orderInfo.makerToken,
            takerToken: orderInfo.takerToken,
            makerAmount,
            takerAmount,
            takerTokenFeeAmount: new BigNumber(orderInfo.takerTokenFeeAmount),
            sender: orderInfo.sender,
            feeRecipient: orderInfo.feeRecipient,
            pool: orderInfo.pool,
            expiry: new BigNumber(orderInfo.expiry),
            salt: new BigNumber(orderInfo.salt),
        });

        const wallet = new Wallet(CONFIG.PRIVATE_KEY);
        const signature = await order.getSignatureWithKey(
            wallet.privateKey,
            SignatureType.EIP712,
        );

        logger.debug('Liquidation order signed successfully');

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
        logger.error('Failed to sign liquidation order', {}, error);
        throw error;
    }
}

// ============================================================================
// STEP 4: TRIGGER LIQUIDATION
// ============================================================================

/**
 * Submit the liquidation bid to the Octarine API.
 * 
 * This triggers the actual on-chain liquidation transaction.
 * The API handles the settlement; we just need to submit our signed order.
 * 
 * @param params - Liquidation parameters including signature
 * @returns API response with bidId and status
 */
async function triggerLiquidation(params: TriggerLiquidationRequest): Promise<any> {
    logger.info(`Triggering liquidation ${params.liquidationId}`, {
        liquidationId: params.liquidationId,
        debtAmount: params.debtAmountToLiquidate,
    });

    return retry(
        async () => {
            const response = await axios.post(
                `${CONFIG.API_BASE_URL}/octarine/liquidations/bid`,
                params,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {}),
                    },
                    timeout: 30000,
                },
            );

            logger.success(`Liquidation triggered successfully`, 0, {
                liquidationId: params.liquidationId,
                txHash: response.data.txHash,
            });

            return response.data;
        },
        {
            maxRetries: 3,
            context: { operation: 'triggerLiquidation', liquidationId: params.liquidationId },
        }
    );
}

// ============================================================================
// LIQUIDATION DECISION LOGIC
// ============================================================================

/**
 * Determine if a liquidation opportunity is worth pursuing.
 * 
 * Validation criteria:
 * 1. Health factor is below 1.0 (position is underwater)
 * 2. Chain is supported
 * 3. Token is not blacklisted
 * 4. Sufficient collateral exists
 * 5. Gas costs don't exceed expected profit
 * 
 * @param liquidation - The liquidation to evaluate
 * @param amounts - Calculated amounts
 * @returns True if the liquidation should be executed
 */
function shouldLiquidate(
    liquidation: Liquidation,
    amounts: LiquidationAmounts,
): boolean {
    const context = { liquidationId: liquidation._id };

    // 1. Check health factor
    if (liquidation.healthFactor >= CONFIG.LIQUIDATION.minHealthFactor) {
        logger.trace(`Skipping: position is healthy`, {
            ...context,
            healthFactor: liquidation.healthFactor,
            minRequired: CONFIG.LIQUIDATION.minHealthFactor,
        });
        return false;
    }

    // 2. Check chain support
    if (!CONFIG.SUPPORTED_CHAINS.includes(+liquidation.chainId)) {
        logger.trace(`Skipping: unsupported chain`, {
            ...context,
            chainId: liquidation.chainId,
        });
        return false;
    }

    // 3. Check blacklist
    if (CONFIG.RISK.blacklistedTokens.length > 0) {
        const isBlacklisted = CONFIG.RISK.blacklistedTokens.some(
            t => t.toLowerCase() === liquidation.collateralAsset.toLowerCase()
        );
        if (isBlacklisted) {
            logger.debug(`Skipping: blacklisted collateral`, context);
            return false;
        }
    }

    // 4. Check token whitelist
    if (CONFIG.ACCEPTED_TOKENS[0] !== '*') {
        const isCollateralAccepted = CONFIG.ACCEPTED_TOKENS.some(
            t => t.toLowerCase() === liquidation.collateralAsset.toLowerCase()
        );
        const isDebtAccepted = CONFIG.ACCEPTED_TOKENS.some(
            t => t.toLowerCase() === liquidation.debtAsset.toLowerCase()
        );
        if (!isCollateralAccepted || !isDebtAccepted) {
            logger.debug(`Skipping: token not in accepted list`, context);
            return false;
        }
    }

    // 5. Validate amounts exist
    if (amounts.debtToRepay === '0' || amounts.collateralToSeize === '0') {
        logger.debug(`Skipping: no liquidatable amount`, {
            ...context,
            debt: amounts.debtToRepay,
            collateral: amounts.collateralToSeize,
        });
        return false;
    }

    // 6. Check minimum profit margin
    // Note: Precise gas estimation would happen right before execution
    // This is a rough pre-filter
    const profitRatio = new BigNumber(amounts.profitWei).dividedBy(amounts.collateralToSeize);
    if (profitRatio.isLessThan(CONFIG.LIQUIDATION.minProfitMarginPercent / 100)) {
        logger.debug(`Skipping: profit margin too low`, {
            ...context,
            profitRatio: profitRatio.toString(),
            minRequired: `${CONFIG.LIQUIDATION.minProfitMarginPercent}%`,
        });
        return false;
    }

    return true;
}

/**
 * Check if we have sufficient balance of the debt token.
 */
async function checkDebtTokenBalance(
    debtToken: string,
    requiredAmount: string,
    wallet: Wallet,
): Promise<boolean> {
    try {
        const tokenContract = new ethers.Contract(
            debtToken,
            ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'],
            wallet.provider!
        );

        const [balance, symbol] = await Promise.all([
            tokenContract.balanceOf(wallet.address),
            tokenContract.symbol().catch(() => 'UNKNOWN'),
        ]);

        const hasBalance = balance.gte(requiredAmount);

        if (!hasBalance) {
            logger.warn(`Insufficient ${symbol} balance for liquidation`, {
                required: requiredAmount,
                available: balance.toString(),
                token: symbol,
            });
        }

        return hasBalance;
    } catch (error) {
        logger.error('Failed to check debt token balance', {}, error as Error);
        return false;
    }
}

// ============================================================================
// MAIN LIQUIDATION PROCESSING
// ============================================================================

/**
 * Process a single liquidation opportunity end-to-end:
 * 1. Validate the opportunity
 * 2. Calculate amounts
 * 3. Check balance
 * 4. Approve debt token
 * 5. Sign the order
 * 6. Trigger liquidation
 */
async function processSingleLiquidation(
    liquidation: Liquidation,
    wallet: Wallet,
): Promise<void> {
    const context = { liquidationId: liquidation._id };

    try {
        logger.trace(`Evaluating liquidation`, {
            ...context,
            borrower: liquidation.borrower.slice(0, 10) + '...',
            healthFactor: liquidation.healthFactor,
            collateralSymbol: liquidation.collateralPosition.asset.symbol,
            debtSymbol: liquidation.borrowedPosition.asset.symbol,
        });

        // Calculate liquidation amounts
        const amounts = calculateLiquidationAmounts(liquidation);

        if (!shouldLiquidate(liquidation, amounts)) {
            return;
        }

        logger.info(`💀 Liquidation opportunity found!`, {
            ...context,
            healthFactor: liquidation.healthFactor,
            collateral: liquidation.collateralPosition.asset.symbol,
            debt: liquidation.borrowedPosition.asset.symbol,
            estimatedProfit: amounts.profitWei,
        });

        // Check debt token balance
        const hasBalance = await checkDebtTokenBalance(
            liquidation.debtAsset,
            amounts.debtToRepay,
            wallet
        );
        if (!hasBalance) {
            return;
        }

        // Build order info
        const orderInfo = buildLiquidationOrderInfo(liquidation, amounts);

        // Approve debt token for the exchange proxy
        await approveTokenToExchangeProxy(
            orderInfo.verifyingContract,
            orderInfo.makerAmount,
            orderInfo.makerToken,
            wallet
        );

        // Sign the liquidation order
        const { order, signature } = await signLiquidationOrder(orderInfo);

        // Submit liquidation bid (expiry is in minutes, convert to what API expects)
        const response = await triggerLiquidation({
            liquidationId: liquidation._id,
            marketMaker: CONFIG.MARKET_MAKER_ADDRESS,
            signature,
            expiry: CONFIG.LIQUIDATION.bidExpiryMinutes,
            orderInfo: order,
            debtAmountToLiquidate: parseInt(amounts.debtToRepay) / 10 ** amounts.debtDecimals,
        });

        // Track bid status
        const bidId = response?.bidId || response?.data?.bidId;
        if (bidId) {
            liquidationBidStats.total++;
            liquidationBidStats.pending++;

            // Check status asynchronously
            setTimeout(async () => {
                const status = await checkLiquidationBidStatus(bidId);
                if (status) {
                    liquidationBidStats.pending--;
                    if (status === 'accepted') liquidationBidStats.accepted++;
                    else if (status === 'failed') liquidationBidStats.failed++;
                }
            }, 5000);
        }

        logger.success(`Successfully processed liquidation ${liquidation._id}`, 0, context);

    } catch (error: any) {
        logger.error(`Failed to process liquidation ${liquidation._id}`, context, error);
    }
}

// ============================================================================
// MAIN LIQUIDATION LOOP
// ============================================================================

/**
 * Start the continuous liquidation monitoring loop.
 * This runs indefinitely, checking for underwater positions.
 */
export async function startLiquidationMonitor(): Promise<void> {
    logger.info('🚀 Starting Liquidation Monitor');
    logger.info('==========================================');
    logger.info(`Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);
    logger.info(`Min Health Factor: ${CONFIG.LIQUIDATION.minHealthFactor}`);
    logger.info(`Max Liquidation Ratio: ${CONFIG.LIQUIDATION.maxLiquidationRatio * 100}%`);
    logger.info(`Min Profit Margin: ${CONFIG.LIQUIDATION.minProfitMarginPercent}%`);
    logger.info('==========================================\n');

    // Track processed liquidations to avoid duplicates
    const processedLiquidations = new Set<string>();

    // Setup wallet
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);

    while (true) {
        const loopStart = Date.now();

        try {
            await liquidationCircuitBreaker.execute(async () => {
                // Fetch open liquidations
                const liquidations = await getOpenLiquidations();

                // Process each liquidation
                for (const liquidation of liquidations) {
                    if (processedLiquidations.has(liquidation._id)) {
                        continue;
                    }

                    await processSingleLiquidation(liquidation, wallet);
                    processedLiquidations.add(liquidation._id);
                }

                // Memory cleanup
                if (processedLiquidations.size > CONFIG.MONITORING.maxTrackedRequests) {
                    const toRemove = Array.from(processedLiquidations).slice(0, 100);
                    toRemove.forEach(id => processedLiquidations.delete(id));
                    logger.debug(`Cleaned up ${toRemove.length} old liquidation entries`);
                }
            });
        } catch (error: any) {
            if (error.message.includes('Circuit breaker is OPEN')) {
                logger.warn('Circuit breaker open - skipping liquidation check');
            } else {
                logger.error('Error in liquidation monitor', {}, error);
            }
        }

        // Log bid statistics periodically
        logLiquidationBidStats();

        // Calculate sleep time
        const elapsed = Date.now() - loopStart;
        const remainingDelay = Math.max(
            0,
            CONFIG.MONITORING.liquidationPollIntervalMs - elapsed
        );

        if (remainingDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingDelay));
        }
    }
}

// Entry point for standalone execution
if (require.main === module) {
    startLiquidationMonitor().catch((error) => {
        logger.error('Liquidation monitor crashed', {}, error);
        process.exit(1);
    });
}
