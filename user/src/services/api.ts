/**
 * Octarine User API Service
 * 
 * This module handles all HTTP communication with the Octarine API
 * for user-facing swap operations.
 * 
 * ## Swap Flow:
 * 
 * 1. **Quote Request**: User submits swap intent (tokenIn, tokenOut, amount)
 * 2. **Route Selection**: API returns either:
 *    - "instant": Pre-approved quote ready for immediate execution
 *    - "rfq": Request goes to market maker auction
 * 3. **Auction (RFQ only)**: Market makers bid, best price wins
 * 4. **Execution**: User signs and submits transaction on-chain
 * 5. **Confirmation**: API records successful fill
 * 
 * ## API Endpoints:
 * 
 * - `POST /octarine/swap` - Request a quote
 * - `GET /octarine/swap/:requestId` - Check swap status/bids
 * - `POST /octarine/fill` - Record successful fill
 * 
 * @module UserAPIService
 */

import axios, { AxiosError } from 'axios';
import { ethers } from 'ethers';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Base URL for Octarine API.
 * In production, this should be configurable via environment variables.
 */
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.mysticfinance.xyz';

/**
 * Default slippage tolerance in percentage points.
 * 1% means the user accepts up to 1% worse than quoted price.
 */
const DEFAULT_SLIPPAGE = 1;

/**
 * Maximum time to wait for RFQ bids (in seconds).
 * After this timeout, the swap is considered failed.
 */
const RFQ_TIMEOUT_SECONDS = 120;

/**
 * Polling interval for RFQ status checks (in milliseconds).
 */
const POLL_INTERVAL_MS = 5000;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Parameters for requesting a swap quote.
 */
export interface QuoteRequestParams {
    /** User's wallet address */
    walletAddress: string;
    /** Token to sell (address) */
    redeemAsset: string;
    /** Token to buy (address) */
    redemptionAsset: string;
    /** Amount to sell (in wei, as string) */
    amount: string;
    /** Chain ID for the swap */
    chainId: number;
    /** Slippage tolerance in percent (default: 1) */
    slippageTolerance?: number;
}

/**
 * API response for a quote request.
 */
export interface QuoteResponse {
    /** Unique request identifier */
    requestId: string;
    /** Quote type: 'instant' or 'rfq' */
    type: 'instant' | 'rfq';
    /** Quote details (for instant swaps) */
    quote?: {
        order: any;
        marketMaker: string;
    };
    /** Transaction data (for instant swaps) */
    txn?: {
        to: string;
        data: string;
        value: string;
    };
}

/**
 * Bid from a market maker (for RFQ swaps).
 */
export interface Bid {
    bidId: string;
    marketMaker: string;
    takerAmount: string;
    takerToken: string;
    txn: {
        to: string;
        data: string;
        value: string;
    };
}

/**
 * RFQ status response.
 */
export interface RFQStatusResponse {
    /** Current auction status */
    status: 'pending' | 'bidding' | 'solved' | 'expired';
    /** Array of received bids */
    bids: Bid[];
    /** Best bid (if available) */
    winningBid?: Bid;
}

/**
 * Result of a swap operation.
 */
export interface SwapResult {
    success: boolean;
    /** Transaction hash (if successful) */
    txHash?: string;
    /** Error message (if failed) */
    error?: string;
    /** Market maker address (if known) */
    marketMaker?: string;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Custom error class for API-related errors.
 */
export class APIError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number,
        public readonly responseData?: any
    ) {
        super(message);
        this.name = 'APIError';
    }
}

/**
 * Handle API errors consistently.
 */
function handleApiError(error: unknown, context: string): never {
    if (error instanceof AxiosError) {
        const statusCode = error.response?.status;
        const responseData = error.response?.data;
        const message = responseData?.message || error.message;
        
        console.error(`[API Error] ${context}:`, {
            statusCode,
            message,
            url: error.config?.url,
        });
        
        throw new APIError(message, statusCode, responseData);
    }
    
    console.error(`[Unexpected Error] ${context}:`, error);
    throw new APIError(String(error));
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Request a swap quote from the Octarine API.
 * 
 * This is the entry point for all swaps. The API analyzes the request
 * and determines the best route:
 * 
 * - **Instant**: Pre-approved market maker quote, can execute immediately
 * - **RFQ**: Goes to auction, requires polling for bids
 * 
 * @param params - Swap parameters
 * @returns Quote response with type and execution data
 * @throws APIError if the request fails
 * 
 * @example
 * ```typescript
 * const quote = await createQuoteRequest({
 *   walletAddress: '0x...',
 *   redeemAsset: '0xTokenIn...',
 *   redemptionAsset: '0xTokenOut...',
 *   amount: '1000000000000000000', // 1 token
 *   chainId: 98866,
 * });
 * 
 * if (quote.type === 'instant') {
 *   // Execute immediately
 * } else {
 *   // Poll for bids
 * }
 * ```
 */
export async function createQuoteRequest(
    params: QuoteRequestParams
): Promise<QuoteResponse> {
    try {
        console.log('[API] Requesting quote:', {
            wallet: params.walletAddress.slice(0, 10) + '...',
            tokenIn: params.redeemAsset.slice(0, 10) + '...',
            tokenOut: params.redemptionAsset.slice(0, 10) + '...',
            amount: params.amount,
        });

        const response = await axios.post<QuoteResponse>(
            `${API_BASE_URL}/octarine/swap`,
            {
                walletAddress: params.walletAddress,
                redeemAsset: params.redeemAsset,
                redemptionAsset: params.redemptionAsset,
                amount: params.amount,
                chainId: params.chainId,
                slippageTolerance: params.slippageTolerance ?? DEFAULT_SLIPPAGE,
            }
        );

        console.log('[API] Quote received:', {
            requestId: response.data.requestId,
            type: response.data.type,
        });

        return response.data;
    } catch (error) {
        handleApiError(error, 'createQuoteRequest');
    }
}

/**
 * Execute a blockchain transaction using the provided signer.
 * 
 * This submits the transaction to the connected wallet (MetaMask, etc.)
 * and waits for confirmation.
 * 
 * @param txnData - Transaction data from API
 * @param signer - Ethers signer instance
 * @returns Transaction hash
 * @throws Error if transaction fails
 */
export async function executeTransaction(
    txnData: QuoteResponse['txn'],
    signer: ethers.Signer
): Promise<string> {
    if (!txnData) {
        throw new Error('No transaction data provided');
    }

    console.log('[Web3] Executing transaction:', {
        to: txnData.to,
        value: txnData.value,
    });

    try {
        const tx = await signer.sendTransaction({
            to: txnData.to,
            data: txnData.data,
            value: txnData.value || 0,
        });

        console.log('[Web3] Transaction sent:', tx.hash);

        const receipt = await tx.wait();
        console.log('[Web3] Transaction confirmed:', receipt?.transactionHash || tx.hash);

        return tx.hash;
    } catch (error: any) {
        console.error('[Web3] Transaction failed:', error);
        
        // Provide user-friendly error messages
        if (error.code === 'ACTION_REJECTED') {
            throw new Error('Transaction was rejected in your wallet');
        }
        if (error.code === 'INSUFFICIENT_FUNDS') {
            throw new Error('Insufficient funds for gas fees');
        }
        
        throw new Error(`Transaction failed: ${error.message}`);
    }
}

/**
 * Record a successful fill with the Octarine API.
 * 
 * This helps the protocol track settlement and attribute fills
 * to the correct market maker.
 * 
 * @param requestId - Original swap request ID
 * @param txHash - Confirmed transaction hash
 * @param filledAmount - Amount that was filled
 * @param marketMaker - Market maker address
 * @param bidId - Optional bid ID (for RFQ fills)
 */
export async function recordFill(
    requestId: string,
    txHash: string,
    filledAmount: string,
    marketMaker: string,
    bidId?: string
): Promise<void> {
    try {
        await axios.post(`${API_BASE_URL}/octarine/fill`, {
            requestId,
            bidId,
            txHash,
            filledAmount,
            marketMaker,
        });

        console.log('[API] Fill recorded:', { requestId, txHash });
    } catch (error) {
        // Non-critical error - log but don't fail the swap
        console.error('[API] Failed to record fill:', error);
    }
}

/**
 * Poll for bids on an RFQ request.
 * 
 * For RFQ swaps, market makers compete in an auction. This function
 * polls the API until bids are received or the timeout expires.
 * 
 * @param requestId - RFQ request ID
 * @param signer - Ethers signer for transaction execution
 * @param options - Polling options
 * @returns Swap result with transaction hash or error
 * 
 * @example
 * ```typescript
 * const result = await pollForBids(requestId, signer);
 * if (result.success) {
 *   console.log('Swap complete:', result.txHash);
 * } else {
 *   console.error('Swap failed:', result.error);
 * }
 * ```
 */
export async function pollForBids(
    requestId: string,
    signer: ethers.Signer,
    options: {
        maxAttempts?: number;
        pollIntervalMs?: number;
    } = {}
): Promise<SwapResult> {
    const maxAttempts = options.maxAttempts ?? (RFQ_TIMEOUT_SECONDS * 1000) / POLL_INTERVAL_MS;
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

    console.log(`[API] Polling for bids on ${requestId}...`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await axios.get<RFQStatusResponse>(
                `${API_BASE_URL}/octarine/swap/${requestId}`
            );

            const { status, bids } = response.data;

            // Check if we have any bids
            if (bids && bids.length > 0) {
                // Select best bid (lowest takerAmount = best for user)
                // In a production app, you might show all bids to the user
                const bestBid = bids.reduce((best, bid) => {
                    const bestAmount = ethers.BigNumber.from(best.takerAmount);
                    const bidAmount = ethers.BigNumber.from(bid.takerAmount);
                    return bidAmount.lt(bestAmount) ? bid : best;
                });

                console.log('[API] Best bid selected:', {
                    marketMaker: bestBid.marketMaker,
                    bidId: bestBid.bidId,
                });

                if (!bestBid.txn) {
                    return {
                        success: false,
                        error: 'Selected bid has no transaction data',
                    };
                }

                // Execute the transaction
                const txHash = await executeTransaction(bestBid.txn, signer);

                // Record the fill
                await recordFill(
                    requestId,
                    txHash,
                    bestBid.takerAmount,
                    bestBid.marketMaker,
                    bestBid.bidId
                );

                return {
                    success: true,
                    txHash,
                    marketMaker: bestBid.marketMaker,
                };
            }

            // Check if the auction expired
            if (status === 'expired') {
                return {
                    success: false,
                    error: 'Auction expired without receiving any bids',
                };
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        } catch (error) {
            console.warn(`[API] Poll attempt ${attempt + 1} failed:`, error);
            // Continue polling - don't fail on transient errors
        }
    }

    return {
        success: false,
        error: `Timeout: No bids received after ${RFQ_TIMEOUT_SECONDS} seconds`,
    };
}

/**
 * Get the best available bid without executing.
 * 
 * Useful for displaying quotes to users before they commit.
 * 
 * @param requestId - RFQ request ID
 * @returns Best bid or null if no bids yet
 */
export async function getBestBid(requestId: string): Promise<Bid | null> {
    try {
        const response = await axios.get<RFQStatusResponse>(
            `${API_BASE_URL}/octarine/swap/${requestId}`
        );

        const { bids } = response.data;
        
        if (!bids || bids.length === 0) {
            return null;
        }

        // Return best bid (lowest takerAmount)
        return bids.reduce((best, bid) => {
            const bestAmount = ethers.BigNumber.from(best.takerAmount);
            const bidAmount = ethers.BigNumber.from(bid.takerAmount);
            return bidAmount.lt(bestAmount) ? bid : best;
        });
    } catch (error) {
        console.error('[API] Failed to get best bid:', error);
        return null;
    }
}
