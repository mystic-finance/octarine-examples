/**
 * RFQ (Request for Quote) API service
 */

import { getApiClient } from './client';
import { RFQRequest, SubmitBidRequest, BidResponse, WonBid, ApiResponse } from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('rfq-api');

export interface GetPendingRequestsParams {
    supportedChains: number[];
    marketMakerAddress: string;
}

/**
 * Get pending RFQ requests
 * Fetches from all supported chains and filters locally
 */
export async function getPendingRequests(params: GetPendingRequestsParams): Promise<RFQRequest[]> {
    const client = getApiClient();

    try {
        // Try fetching without chainId filter first (if API supports it)
        const response = await client.get<ApiResponse<RFQRequest[]>>('/octarine/requests', {
            params: {
                status: 'pending,bidding',
                marketMaker: params.marketMakerAddress,
            },
        });

        const requests = response.data || [];

        // Filter by supported chains locally
        const filtered = requests.filter(req =>
            params.supportedChains.includes(req.chainId),
        );

        logger.info('Fetched pending requests', {
            total: requests.length,
            filtered: filtered.length,
            chains: params.supportedChains,
        });

        return filtered;
    } catch (error) {
        // If API requires chainId, fall back to fetching per chain
        logger.debug('Falling back to per-chain fetch');
        return getPendingRequestsPerChain(params);
    }
}

/**
 * Fallback: fetch requests per chain
 */
async function getPendingRequestsPerChain(params: GetPendingRequestsParams): Promise<RFQRequest[]> {
    const client = getApiClient();
    const allRequests: RFQRequest[] = [];

    for (const chainId of params.supportedChains) {
        try {
            const response = await client.get<ApiResponse<RFQRequest[]>>('/octarine/requests', {
                params: {
                    status: 'pending,bidding',
                    chainId,
                    marketMaker: params.marketMakerAddress,
                },
            });

            const requests = response.data || [];
            allRequests.push(...requests);

            logger.debug('Fetched requests for chain', {
                chainId,
                count: requests.length,
            });
        } catch (error) {
            logger.warn('Failed to fetch requests for chain', {
                chainId,
                error: error instanceof Error ? error.message : String(error),
            });
            // Continue with other chains
        }
    }

    return allRequests;
}

/**
 * Submit a bid for an RFQ request
 */
export async function submitBid(params: SubmitBidRequest): Promise<BidResponse> {
    const client = getApiClient();

    logger.info('Submitting bid', {
        requestId: params.requestId,
        maker: params.maker,
        makerAmount: params.makerAmount,
    });

    const response = await client.post<ApiResponse<BidResponse>>('/octarine/bid', params);

    logger.info('Bid submitted', {
        requestId: params.requestId,
        bidId: response.data.bidId,
    });

    return response.data;
}

/**
 * Get accepted (won) bids for a market maker
 */
export async function getWonBids(marketMakerAddress: string, limit: number = 20): Promise<WonBid[]> {
    const client = getApiClient();

    const response = await client.get<{ bids: WonBid[] }>(
        `/octarine/market-maker/${marketMakerAddress}/bids`,
        {
            params: {
                status: 'accepted',
                limit,
            },
        },
    );

    return response.bids || [];
}

/**
 * Trigger transform for a won bid
 */
export async function callTransform(requestId: string): Promise<{ txHash?: string }> {
    const client = getApiClient();

    logger.info('Calling transform', { requestId });

    try {
        const response = await client.post<{ txHash?: string }>('/octarine/transform', {
            requestId,
        });

        logger.info('Transform triggered', {
            requestId,
            txHash: response.txHash,
        });

        return response;
    } catch (error) {
        // Check if already executed
        if (error instanceof Error && error.message.includes('Already executed')) {
            logger.debug('Transform already executed', { requestId });
            return {};
        }
        throw error;
    }
}
