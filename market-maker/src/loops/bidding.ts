/**
 * RFQ Bidding Loop
 * Handles instant redemption bidding with improved reliability
 */

import { BigNumber } from '@0x/utils';
import { RFQRequest, AppConfig } from '../types';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { delay } from '../utils/delay';
import { signLimitOrder, calculateExpiry } from '../utils/signing';
import { getWalletManager } from '../services/wallet';
import { approveTokenToExchangeProxy } from '../services/wallet/approvals';
import { getPendingRequests, submitBid, getWonBids, callTransform } from '../services/api/rfq';
import { getNotificationService } from '../services/notifications';
import { getWebSocket, WebSocketEvent, OctarineWebSocket } from '../services/api/websocket';

const logger = createLogger('bidding');

// Use Map with timestamps for proper cleanup
const processedRequests = new Map<string, number>();

// Constants
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PROCESSED_ENTRIES = 1000;

/**
 * Check if we should bid on this request
 */
function shouldBidOnRequest(request: RFQRequest, cfg: AppConfig): boolean {
    // Check supported tokens
    if (cfg.acceptedTokens[0] !== '*') {
        const redeemAsset = request.redeemAsset.toLowerCase();
        const isSupported = cfg.acceptedTokens.some(t => t.toLowerCase() === redeemAsset);
        if (!isSupported) {
            logger.debug('Skipping request: unsupported token', {
                requestId: request.requestId,
                token: request.redeemAsset,
            });
            return false;
        }
    }

    // Check minimum amount
    const minAmount = new BigNumber(cfg.minBidAmountWei);
    if (new BigNumber(request.redeemAmount).isLessThan(minAmount)) {
        logger.debug('Skipping request: amount too small', {
            requestId: request.requestId,
            amount: request.redeemAmount,
            minimum: cfg.minBidAmountWei,
        });
        return false;
    }

    // Check chain (already filtered by API service, but double-check)
    if (!cfg.supportedChains.includes(request.chainId)) {
        logger.debug('Skipping request: unsupported chain', {
            requestId: request.requestId,
            chainId: request.chainId,
        });
        return false;
    }

    // Check expiration (need at least 30 seconds)
    const timeLeft = request.expiry - Math.floor(Date.now() / 1000);
    if (timeLeft < 30) {
        logger.debug('Skipping request: expiring soon', {
            requestId: request.requestId,
            timeLeftSeconds: timeLeft,
        });
        return false;
    }

    return true;
}

/**
 * Calculate quote (maker amount) based on spread
 */
function calculateQuote(request: RFQRequest, cfg: AppConfig): string {
    const takerAmount = new BigNumber(request.redeemAmount);
    const quote = takerAmount.multipliedBy(cfg.priceSpread).integerValue();

    logger.debug('Calculated quote', {
        requestId: request.requestId,
        takerAmount: request.redeemAmount,
        makerAmount: quote.toString(),
        spread: `${(1 - cfg.priceSpread) * 100}%`,
    });

    return quote.toString();
}

/**
 * Process a single RFQ request
 */
async function processSingleRequest(request: RFQRequest, cfg: AppConfig): Promise<void> {
    const requestId = request.requestId;

    try {
        logger.info('Processing request', { requestId, chainId: request.chainId });

        if (!shouldBidOnRequest(request, cfg)) {
            return;
        }

        const metadata = request.metadata?.rfqOrder;
        if (!metadata) {
            logger.warn('Request missing metadata.rfqOrder', { requestId });
            return;
        }

        const makerAmount = calculateQuote(request, cfg);
        const walletManager = getWalletManager();

        // Approve token if needed
        await approveTokenToExchangeProxy(
            metadata.verifyingContract,
            makerAmount,
            metadata.makerToken,
            walletManager,
        );

        // Sign the order
        const { signature } = await signLimitOrder(
            {
                chainId: metadata.chainId,
                verifyingContract: metadata.verifyingContract,
                maker: cfg.marketMakerAddress,
                taker: metadata.taker,
                makerToken: metadata.makerToken,
                takerToken: metadata.takerToken,
                makerAmount,
                takerAmount: metadata.takerAmount,
                pool: metadata.pool,
                sender: metadata.sender,
                feeRecipient: metadata.feeRecipient,
                takerTokenFeeAmount: metadata.takerTokenFeeAmount,
                expiry: metadata.expiry,
                salt: String(metadata.salt),
            },
            walletManager.getWallet(),
        );

        // Submit bid
        await submitBid({
            requestId,
            maker: cfg.marketMakerAddress,
            makerAmount,
            expiry: 60, // Bid valid for 60 minutes
            signature,
            activeFrom: 0,
        });

        logger.info('Bid submitted successfully', { requestId, makerAmount });

    } catch (error) {
        logger.error('Failed to process request', error instanceof Error ? error : new Error(String(error)), {
            requestId,
        });

        getNotificationService().notifyApiError('Bid submission', error instanceof Error ? error : new Error(String(error)), {
            requestId,
        });
    }
}

/**
 * Monitor for won bids and trigger transforms
 */
async function monitorWonBids(cfg: AppConfig): Promise<void> {
    try {
        const wonBids = await getWonBids(cfg.marketMakerAddress);

        for (const bid of wonBids) {
            const transformKey = `transform-${bid.requestId}`;

            if (processedRequests.has(transformKey)) {
                continue;
            }

            logger.info('Bid won! Triggering transform', {
                requestId: bid.requestId,
                bidId: bid.bidId,
            });

            getNotificationService().notifyBidWon(bid.requestId, bid.makerAmount);

            try {
                const result = await callTransform(bid.requestId);
                processedRequests.set(transformKey, Date.now());

                getNotificationService().notifyTransformExecuted(bid.requestId, result.txHash);
            } catch (error) {
                logger.error('Failed to trigger transform', error instanceof Error ? error : new Error(String(error)), {
                    requestId: bid.requestId,
                });
            }
        }
    } catch (error) {
        logger.warn('Failed to check won bids', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Clean up old processed entries (older than 1 hour)
 */
function cleanupProcessedRequests(): void {
    const now = Date.now();
    const oneHourAgo = now - CLEANUP_INTERVAL_MS;
    let removed = 0;

    for (const [id, timestamp] of processedRequests) {
        if (timestamp < oneHourAgo) {
            processedRequests.delete(id);
            removed++;
        }
    }

    // If still too many, remove oldest entries
    if (processedRequests.size > MAX_PROCESSED_ENTRIES) {
        const entries = Array.from(processedRequests.entries())
            .sort((a, b) => a[1] - b[1]); // Sort by timestamp

        const toRemove = entries.slice(0, entries.length - MAX_PROCESSED_ENTRIES);
        for (const [id] of toRemove) {
            processedRequests.delete(id);
            removed++;
        }
    }

    if (removed > 0) {
        logger.debug('Cleaned up processed requests', {
            removed,
            remaining: processedRequests.size,
        });
    }
}

/**
 * Handle WebSocket event for real-time RFQ requests
 */
function handleWebSocketEvent(event: WebSocketEvent, cfg: AppConfig): void {
    if (event.type === 'rfq_request') {
        const request = event.data;

        if (processedRequests.has(request.requestId)) {
            return;
        }

        logger.debug('Received RFQ request via WebSocket', {
            requestId: request.requestId,
        });

        // Process immediately
        processSingleRequest(request, cfg)
            .then(() => {
                processedRequests.set(request.requestId, Date.now());
            })
            .catch(error => {
                logger.error('Failed to process WebSocket request', error);
            });
    } else if (event.type === 'bid_accepted') {
        logger.info('Bid accepted via WebSocket', {
            requestId: event.data.requestId,
            bidId: event.data.bidId,
        });

        // Trigger transform
        callTransform(event.data.requestId).catch(error => {
            logger.error('Failed to trigger transform from WebSocket event', error);
        });
    }
}

/**
 * Main bidding loop with polling
 */
export async function startBiddingLoop(): Promise<void> {
    const cfg = config;

    logger.info('Starting instant redemption bidding bot', {
        marketMaker: cfg.marketMakerAddress,
        spread: `${(1 - cfg.priceSpread) * 100}%`,
        chains: cfg.supportedChains,
    });

    // Setup WebSocket if enabled
    const ws = getWebSocket();
    if (ws) {
        ws.on('event', (event: WebSocketEvent) => handleWebSocketEvent(event, cfg));
        logger.info('WebSocket event handler registered');
    }

    // Main polling loop (runs alongside WebSocket for redundancy)
    while (true) {
        try {
            // Get pending requests
            const requests = await getPendingRequests({
                supportedChains: cfg.supportedChains,
                marketMakerAddress: cfg.marketMakerAddress,
            });

            logger.debug('Found pending requests', { count: requests.length });

            // Process each request
            for (const request of requests) {
                if (processedRequests.has(request.requestId)) {
                    continue;
                }

                await processSingleRequest(request, cfg);
                processedRequests.set(request.requestId, Date.now());
            }

            // Monitor won bids
            await monitorWonBids(cfg);

            // Cleanup old entries
            cleanupProcessedRequests();

        } catch (error) {
            logger.error('Error in bidding loop', error instanceof Error ? error : new Error(String(error)));
        }

        await delay(cfg.biddingPollIntervalMs);
    }
}
