/**
 * Liquidation API service
 */

import { getApiClient } from './client';
import { Liquidation, TriggerLiquidationRequest, ApiResponse } from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('liquidation-api');

export interface GetLiquidationsParams {
    supportedChains: number[];
    limit?: number;
}

/**
 * Get open liquidation opportunities
 * Fetches from all supported chains
 */
export async function getOpenLiquidations(params: GetLiquidationsParams): Promise<Liquidation[]> {
    const client = getApiClient();

    try {
        // Try fetching without chainId filter first
        const response = await client.get<ApiResponse<Liquidation[]>>(
            '/redemptions/liquidations/opportunities',
            {
                params: {
                    limit: params.limit || 1000,
                },
            },
        );

        const liquidations = response.data || [];

        // Filter by supported chains locally
        const filtered = liquidations.filter(liq =>
            params.supportedChains.includes(liq.chainId),
        );

        logger.info('Fetched liquidation opportunities', {
            total: liquidations.length,
            filtered: filtered.length,
            chains: params.supportedChains,
        });

        return filtered;
    } catch (error) {
        // Fall back to fetching per chain
        logger.debug('Falling back to per-chain fetch for liquidations');
        return getOpenLiquidationsPerChain(params);
    }
}

/**
 * Fallback: fetch liquidations per chain
 */
async function getOpenLiquidationsPerChain(params: GetLiquidationsParams): Promise<Liquidation[]> {
    const client = getApiClient();
    const allLiquidations: Liquidation[] = [];

    for (const chainId of params.supportedChains) {
        try {
            const response = await client.get<ApiResponse<Liquidation[]>>(
                '/redemptions/liquidations/opportunities',
                {
                    params: {
                        chainId,
                        limit: params.limit || 1000,
                    },
                },
            );

            const liquidations = response.data || [];
            allLiquidations.push(...liquidations);

            logger.debug('Fetched liquidations for chain', {
                chainId,
                count: liquidations.length,
            });
        } catch (error) {
            logger.warn('Failed to fetch liquidations for chain', {
                chainId,
                error: error instanceof Error ? error.message : String(error),
            });
            // Continue with other chains
        }
    }

    return allLiquidations;
}

/**
 * Trigger a liquidation
 */
export async function triggerLiquidation(
    params: TriggerLiquidationRequest,
): Promise<{ txHash: string }> {
    const client = getApiClient();

    logger.info('Triggering liquidation', {
        liquidationId: params.liquidationId,
        marketMaker: params.marketMaker,
        debtAmount: params.debtAmountToLiquidate,
    });

    const response = await client.post<{ txHash: string }>(
        '/redemptions/liquidations/bid',
        params,
    );

    logger.info('Liquidation triggered', {
        liquidationId: params.liquidationId,
        txHash: response.txHash,
    });

    return response;
}
