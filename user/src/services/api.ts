/**
 * Octarine API Integration for User Swaps
 * 
 * This module handles all API interactions for the user swap flow:
 * 1. Requesting quotes (both instant and RFQ-based)
 * 2. Polling for bids during RFQ auctions
 * 3. Recording fills after successful swaps
 * 
 * ## Swap Types
 * 
 * **Instant Swap**: Pre-approved quote that can execute immediately
 * **RFQ (Request for Quote)**: Competitive bidding process where market makers 
 * submit quotes, and the best one is selected
 * 
 * ## Usage Flow
 * 
 * 1. Call `createQuoteRequest()` to get initial quote
 * 2. If instant: use `executeTransaction()` with the provided txn data
 * 3. If RFQ: poll for bids with `pollForBids()` then execute
 * 4. Record the fill with `recordFill()`
 */

import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { ethers, Signer } from 'ethers';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Base URL for the Octarine API */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.mysticfinance.xyz';

/** Default timeout for API requests (ms) */
const DEFAULT_TIMEOUT = 30000;

/** Default retry attempts for failed requests */
const MAX_RETRIES = 3;

/** Delay between retries (ms) - uses exponential backoff */
const RETRY_DELAY_BASE = 1000;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Parameters for creating a quote request
 */
export interface QuoteRequestParams {
    /** User's wallet address */
    walletAddress: string;
    /** Token address being sold (redeem asset) */
    redeemAsset: string;
    /** Token address being bought (redemption asset) */
    redemptionAsset: string;
    /** Amount to swap (in wei) */
    amount: string;
    /** Chain ID for the swap */
    chainId: number;
    /** Slippage tolerance in percentage (default: 1) */
    slippageTolerance?: number;
}

/**
 * Quote response from the API
 */
export interface QuoteResponse {
    /** Type of quote: instant or rfq */
    type: 'instant' | 'rfq';
    /** Unique request ID */
    requestId: string;
    /** Quote metadata (for instant swaps) */
    quote?: {
        marketMaker: string;
        order?: {
            verifyingContract: string;
            makerAmount: string;
            takerAmount: string;
        };
    };
    /** Transaction data (for instant swaps) */
    txn?: TransactionData;
}

/**
 * Transaction data for execution
 */
export interface TransactionData {
    /** Target contract address */
    to: string;
    /** Transaction calldata */
    data: string;
    /** ETH value to send (in wei) */
    value: string;
    /** Estimated gas limit */
    gasLimit?: string;
}

/**
 * Bid from a market maker
 */
export interface MarketMakerBid {
    /** Unique bid ID */
    bidId: string;
    /** Market maker address */
    marketMaker: string;
    /** Amount they're offering */
    makerAmount: string;
    /** Transaction data to execute */
    txn: TransactionData;
}

/**
 * Result of polling for bids
 */
export interface PollResult {
    /** Whether the polling succeeded */
    success: boolean;
    /** Transaction hash if successful */
    txHash?: string;
    /** Error message if failed */
    error?: string;
}

// ============================================================================
// RETRY UTILITY
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = MAX_RETRIES,
    context?: string
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // Don't retry on 4xx errors (client errors)
            if (error?.response?.status >= 400 && error?.response?.status < 500) {
                console.error(`[API] ${context}: Client error, not retrying`, error.message);
                throw error;
            }

            if (attempt < maxRetries) {
                const delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
                console.warn(`[API] ${context}: Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Request a quote from the Octarine API.
 * 
 * This is the entry point for all swaps. The API returns either:
 * - An instant quote that can be executed immediately, or
 * - An RFQ request ID that requires polling for market maker bids
 * 
 * @param params - Quote request parameters
 * @returns Quote response with type, requestId, and execution data
 * 
 * @example
 * ```typescript
 * const quote = await createQuoteRequest({
 *   walletAddress: '0x...',
 *   redeemAsset: '0xaa...',     // RWA token
 *   redemptionAsset: '0xbb...', // pUSD
 *   amount: '1000000000000000000', // 1 token (18 decimals)
 *   chainId: 98866,
 *   slippageTolerance: 1,
 * });
 * 
 * if (quote.type === 'instant') {
 *   // Execute immediately
 * } else {
 *   // Poll for bids
 * }
 * ```
 */
export async function createQuoteRequest(params: QuoteRequestParams): Promise<QuoteResponse> {
    const { walletAddress, redeemAsset, redemptionAsset, amount, chainId, slippageTolerance = 1 } = params;

    console.log('[Swap] Requesting quote:', {
        sell: `${amount} of ${redeemAsset.slice(0, 10)}...`,
        buy: redemptionAsset.slice(0, 10) + '...',
    });

    return withRetry(async () => {
        const response = await axios.post(
            `${API_BASE_URL}/octarine/swap`,
            {
                walletAddress,
                redeemAsset,
                redemptionAsset,
                amount,
                chainId,
                slippageTolerance,
            },
            {
                timeout: DEFAULT_TIMEOUT,
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );

        const data = response.data;
        console.log('[Swap] Quote received:', {
            type: data.type,
            requestId: data.requestId,
        });

        return data as QuoteResponse;
    }, MAX_RETRIES, 'createQuoteRequest');
}

/**
 * Execute a blockchain transaction using the user's signer.
 * 
 * This submits the transaction to the network and waits for confirmation.
 * The transaction data comes from the quote or bid response.
 * 
 * @param txnData - Transaction data from quote/bid
 * @param signer - Ethers signer (connected wallet)
 * @returns Transaction hash
 * @throws Error if transaction fails
 * 
 * @example
 * ```typescript
 * const txHash = await executeTransaction(quote.txn, signer);
 * console.log('Swap executed:', txHash);
 * ```
 */
export async function executeTransaction(
    txnData: TransactionData,
    signer: Signer
): Promise<string> {
    console.log('[Swap] Executing transaction:', {
        to: txnData.to,
        dataLength: txnData.data.length,
        value: txnData.value,
    });

    try {
        // Estimate gas if not provided
        let gasLimit = txnData.gasLimit;
        if (!gasLimit) {
            const estimatedGas = await signer.estimateGas({
                to: txnData.to,
                data: txnData.data,
                value: txnData.value,
            });
            // Add 20% buffer for safety
            gasLimit = estimatedGas.mul(120).div(100).toString();
            console.log('[Swap] Gas estimated:', estimatedGas.toString(), 'with buffer:', gasLimit);
        }

        // Send the transaction
        const tx = await signer.sendTransaction({
            to: txnData.to,
            data: txnData.data,
            value: txnData.value,
            gasLimit,
        });

        console.log('[Swap] Transaction sent:', tx.hash);

        // Wait for confirmation (1 confirmation for speed, can increase for security)
        const receipt = await tx.wait(1);
        
        if (receipt.status === 0) {
            throw new Error('Transaction failed on-chain');
        }

        console.log('[Swap] Transaction confirmed:', {
            hash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
        });

        return receipt.transactionHash;
    } catch (error: any) {
        console.error('[Swap] Transaction failed:', error.message);
        
        // Provide more helpful error messages
        if (error.code === 'INSUFFICIENT_FUNDS') {
            throw new Error('Insufficient funds for gas fees');
        }
        if (error.code === 'UNPREDICTABLE_GAS_LIMIT') {
            throw new Error('Transaction will fail - check token approvals and balances');
        }
        if (error.code === 'ACTION_REJECTED') {
            throw new Error('Transaction rejected by user');
        }
        
        throw error;
    }
}

/**
 * Record a fill after successful swap execution.
 * 
 * This notifies the Octarine protocol that a swap has completed,
 * allowing proper accounting and settlement.
 * 
 * @param requestId - The original quote request ID
 * @param txHash - The on-chain transaction hash
 * @param filledAmount - Amount that was filled
 * @param marketMaker - Market maker that provided the quote
 * @param bidId - Optional bid ID (for RFQ swaps)
 */
export async function recordFill(
    requestId: string,
    txHash: string,
    filledAmount: string,
    marketMaker: string,
    bidId?: string
): Promise<void> {
    console.log('[Swap] Recording fill:', {
        requestId,
        txHash,
        marketMaker: marketMaker.slice(0, 10) + '...',
    });

    try {
        await axios.post(
            `${API_BASE_URL}/octarine/fill`,
            {
                requestId,
                bidId,
                txHash,
                filledAmount,
                marketMaker,
            },
            {
                timeout: 10000,
            }
        );
        console.log('[Swap] Fill recorded successfully');
    } catch (error: any) {
        // Log but don't throw - the swap succeeded on-chain
        console.error('[Swap] Failed to record fill (non-fatal):', error.message);
    }
}

/**
 * Poll for market maker bids during RFQ auction.
 * 
 * When a quote type is 'rfq', the swap enters a competitive bidding period
 * where market makers submit quotes. This function polls the API until:
 * - Bids are received and one is selected
 * - The auction times out
 * - An error occurs
 * 
 * @param requestId - The RFQ request ID to poll
 * @param signer - Ethers signer for executing the winning bid
 * @param options - Polling options
 * @returns Result with txHash if successful
 * 
 * @example
 * ```typescript
 * const result = await pollForBids(requestId, signer, {
 *   maxAttempts: 60,      // Max 60 polls
 *   pollIntervalMs: 15000 // Poll every 15 seconds
 * });
 * 
 * if (result.success) {
 *   console.log('Swap completed:', result.txHash);
 * } else {
 *   console.log('Auction timed out');
 * }
 * ```
 */
export interface PollOptions {
    /** Maximum number of poll attempts (default: 60) */
    maxAttempts?: number;
    /** Poll interval in milliseconds (default: 15000) */
    pollIntervalMs?: number;
    /** Bid selection strategy: 'best' | 'first' (default: 'best') */
    bidStrategy?: 'best' | 'first';
}

export async function pollForBids(
    requestId: string,
    signer: Signer,
    options: PollOptions = {}
): Promise<PollResult> {
    const {
        maxAttempts = 60,
        pollIntervalMs = 15000,
        bidStrategy = 'best',
    } = options;

    console.log(`[Swap] Polling for bids on ${requestId}...`);
    console.log(`[Swap] Config: maxAttempts=${maxAttempts}, interval=${pollIntervalMs}ms, strategy=${bidStrategy}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios.get(
                `${API_BASE_URL}/octarine/swap/${requestId}`,
                { timeout: 10000 }
            );

            const bids: MarketMakerBid[] = response.data.bids || [];

            if (bids.length > 0) {
                console.log(`[Swap] Received ${bids.length} bid(s) on attempt ${attempt}`);

                // Select the best bid based on strategy
                const selectedBid = selectBid(bids, bidStrategy);

                if (!selectedBid.txn) {
                    throw new Error('Selected bid has no transaction data');
                }

                console.log(`[Swap] Selected bid from ${selectedBid.marketMaker.slice(0, 10)}...`, {
                    makerAmount: selectedBid.makerAmount,
                    bidId: selectedBid.bidId,
                });

                // Execute the transaction
                const txHash = await executeTransaction(selectedBid.txn, signer);

                // Record the fill
                await recordFill(
                    requestId,
                    txHash,
                    selectedBid.makerAmount,
                    selectedBid.marketMaker,
                    selectedBid.bidId
                );

                return { success: true, txHash };
            }

            // No bids yet, continue polling
            if (attempt % 4 === 0) {
                console.log(`[Swap] Still polling... (attempt ${attempt}/${maxAttempts})`);
            }

        } catch (error: any) {
            console.error(`[Swap] Polling error on attempt ${attempt}:`, error.message);
            
            // Continue polling unless it's a fatal error
            if (error?.response?.status === 404) {
                return { success: false, error: 'Request not found' };
            }
        }

        // Wait before next poll
        if (attempt < maxAttempts) {
            await sleep(pollIntervalMs);
        }
    }

    console.warn(`[Swap] Polling timed out after ${maxAttempts} attempts`);
    return { success: false, error: 'Timeout: No bids received' };
}

/**
 * Select the best bid from available options
 */
function selectBid(bids: MarketMakerBid[], strategy: 'best' | 'first'): MarketMakerBid {
    if (strategy === 'first' || bids.length === 1) {
        return bids[0];
    }

    // 'best' strategy - highest makerAmount
    return bids.reduce((best, current) => {
        try {
            const bestAmount = ethers.BigNumber.from(best.makerAmount);
            const currentAmount = ethers.BigNumber.from(current.makerAmount);
            return currentAmount.gt(bestAmount) ? current : best;
        } catch (e) {
            // If comparison fails, keep current best
            return best;
        }
    }, bids[0]);
}

/**
 * Check the status of a swap request.
 * Useful for checking if a previous RFQ request has been filled.
 */
export async function getSwapStatus(requestId: string): Promise<{
    status: string;
    bids: MarketMakerBid[];
    txHash?: string;
}> {
    const response = await axios.get(
        `${API_BASE_URL}/octarine/swap/${requestId}`,
        { timeout: 10000 }
    );
    return response.data;
}

/**
 * Get supported tokens for swaps.
 */
export async function getSupportedTokens(chainId: number): Promise<{
    address: string;
    symbol: string;
    name: string;
    decimals: number;
}[]> {
    return withRetry(async () => {
        const response = await axios.get(
            `${API_BASE_URL}/octarine/tokens`,
            {
                params: { chainId },
                timeout: 10000,
            }
        );
        return response.data.tokens || [];
    }, 2, 'getSupportedTokens');
}
