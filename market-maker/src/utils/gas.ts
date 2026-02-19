/**
 * Gas Estimation and Pricing Utilities
 * 
 * Provides intelligent gas pricing strategies for Ethereum transactions.
 * Critical for ensuring transactions are included promptly without overpaying.
 */

import { ethers } from 'ethers';
import { logger } from './logger';

export interface GasEstimate {
    /** Estimated gas limit for the transaction */
    gasLimit: ethers.BigNumber;
    /** Suggested gas price (Legacy) */
    gasPrice?: ethers.BigNumber;
    /** EIP-1559 max fee per gas */
    maxFeePerGas?: ethers.BigNumber;
    /** EIP-1559 max priority fee per gas */
    maxPriorityFeePerGas?: ethers.BigNumber;
    /** Estimated cost in wei */
    estimatedCostWei: ethers.BigNumber;
    /** Estimated cost in ETH (formatted) */
    estimatedCostEth: string;
}

export interface GasStrategy {
    /** Speed priority: 'slow', 'standard', 'fast', 'urgent' */
    speed: 'slow' | 'standard' | 'fast' | 'urgent';
    /** Maximum gas price willing to pay (in gwei) */
    maxGasPriceGwei?: number;
    /** Whether to use EIP-1559 (London hard fork) transactions */
    useEip1559?: boolean;
}

// Gas price multipliers based on speed
const SPEED_MULTIPLIERS: Record<string, number> = {
    slow: 0.8,      // 80% of base
    standard: 1.0,  // Base price
    fast: 1.2,      // 120% of base
    urgent: 1.5,    // 150% of base (for high-priority transactions)
};

// Priority fee suggestions (in gwei) based on network congestion
const PRIORITY_FEE_TIERS: Record<string, number> = {
    slow: 1,
    standard: 2,
    fast: 5,
    urgent: 10,
};

/**
 * Get current gas prices from the network
 */
export async function getCurrentGasPrices(
    provider: ethers.providers.Provider
): Promise<{
    baseFeePerGas: ethers.BigNumber | null;
    gasPrice: ethers.BigNumber;
}> {
    const feeData = await provider.getFeeData();
    
    return {
        baseFeePerGas: feeData.lastBaseFeePerGas,
        gasPrice: feeData.gasPrice || ethers.utils.parseUnits('50', 'gwei'),
    };
}

/**
 * Calculate gas parameters based on strategy
 */
export async function calculateGasParams(
    provider: ethers.providers.Provider,
    strategy: GasStrategy = { speed: 'standard', useEip1559: true }
): Promise<{
    gasPrice?: ethers.BigNumber;
    maxFeePerGas?: ethers.BigNumber;
    maxPriorityFeePerGas?: ethers.BigNumber;
}> {
    const { baseFeePerGas, gasPrice } = await getCurrentGasPrices(provider);
    const multiplier = SPEED_MULTIPLIERS[strategy.speed];

    // Check if EIP-1559 is supported
    const supportsEip1559 = baseFeePerGas !== null && strategy.useEip1559 !== false;

    if (supportsEip1559) {
        // EIP-1559 transaction
        const priorityFee = ethers.utils.parseUnits(
            PRIORITY_FEE_TIERS[strategy.speed].toString(),
            'gwei'
        );

        // maxFeePerGas = (baseFee * 2) + priorityFee (buffer for base fee fluctuation)
        const maxFeePerGas = baseFeePerGas!
            .mul(2)
            .add(priorityFee)
            .mul(Math.floor(multiplier * 100))
            .div(100);

        // Apply max gas price limit if specified
        if (strategy.maxGasPriceGwei) {
            const maxGasPriceWei = ethers.utils.parseUnits(
                strategy.maxGasPriceGwei.toString(),
                'gwei'
            );
            
            if (maxFeePerGas.gt(maxGasPriceWei)) {
                logger.warn(
                    `Max fee ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei exceeds limit, capping at ${strategy.maxGasPriceGwei} gwei`
                );
                return {
                    maxFeePerGas: maxGasPriceWei,
                    maxPriorityFeePerGas: priorityFee,
                };
            }
        }

        return {
            maxFeePerGas,
            maxPriorityFeePerGas: priorityFee,
        };
    } else {
        // Legacy transaction
        const adjustedGasPrice = gasPrice
            .mul(Math.floor(multiplier * 100))
            .div(100);

        if (strategy.maxGasPriceGwei) {
            const maxGasPriceWei = ethers.utils.parseUnits(
                strategy.maxGasPriceGwei.toString(),
                'gwei'
            );
            
            if (adjustedGasPrice.gt(maxGasPriceWei)) {
                logger.warn(
                    `Gas price ${ethers.utils.formatUnits(adjustedGasPrice, 'gwei')} gwei exceeds limit, capping at ${strategy.maxGasPriceGwei} gwei`
                );
                return { gasPrice: maxGasPriceWei };
            }
        }

        return { gasPrice: adjustedGasPrice };
    }
}

/**
 * Estimate gas cost for a transaction
 */
export async function estimateGasCost(
    provider: ethers.providers.Provider,
    transaction: ethers.providers.TransactionRequest,
    strategy: GasStrategy = { speed: 'standard' }
): Promise<GasEstimate> {
    // Estimate gas limit
    const gasLimit = await provider.estimateGas(transaction);
    
    // Add 20% buffer for safety
    const gasLimitWithBuffer = gasLimit.mul(120).div(100);

    // Get gas prices
    const gasParams = await calculateGasParams(provider, strategy);

    let estimatedCostWei: ethers.BigNumber;

    if (gasParams.maxFeePerGas) {
        // EIP-1559
        estimatedCostWei = gasLimitWithBuffer.mul(gasParams.maxFeePerGas);
    } else if (gasParams.gasPrice) {
        // Legacy
        estimatedCostWei = gasLimitWithBuffer.mul(gasParams.gasPrice);
    } else {
        throw new Error('Unable to determine gas pricing');
    }

    return {
        gasLimit: gasLimitWithBuffer,
        ...gasParams,
        estimatedCostWei,
        estimatedCostEth: ethers.utils.formatEther(estimatedCostWei),
    };
}

/**
 * Check if a transaction would be profitable after gas costs
 */
export function isProfitableAfterGas(
    expectedProfitWei: ethers.BigNumber,
    gasCostWei: ethers.BigNumber,
    minProfitMarginPercent = 10
): { profitable: boolean; netProfitWei: ethers.BigNumber } {
    const netProfitWei = expectedProfitWei.sub(gasCostWei);
    
    // Calculate minimum acceptable profit
    const minProfit = expectedProfitWei.mul(minProfitMarginPercent).div(100);

    return {
        profitable: netProfitWei.gte(minProfit),
        netProfitWei,
    };
}

/**
 * Format gas prices for display
 */
export function formatGasPrices(
    gasParams: ReturnType<typeof calculateGasParams> extends Promise<infer T> ? T : never
): string {
    const parts: string[] = [];

    if (gasParams.maxFeePerGas) {
        parts.push(`maxFee: ${ethers.utils.formatUnits(gasParams.maxFeePerGas, 'gwei')} gwei`);
    }
    if (gasParams.maxPriorityFeePerGas) {
        parts.push(`priority: ${ethers.utils.formatUnits(gasParams.maxPriorityFeePerGas, 'gwei')} gwei`);
    }
    if (gasParams.gasPrice) {
        parts.push(`gasPrice: ${ethers.utils.formatUnits(gasParams.gasPrice, 'gwei')} gwei`);
    }

    return parts.join(', ') || 'unknown';
}

/**
 * Gas price monitor - tracks gas prices over time for analytics
 */
export class GasPriceMonitor {
    private history: Array<{ timestamp: number; baseFee: string }> = [];
    private maxHistorySize = 100;

    record(baseFeePerGas: ethers.BigNumber): void {
        this.history.push({
            timestamp: Date.now(),
            baseFee: ethers.utils.formatUnits(baseFeePerGas, 'gwei'),
        });

        // Keep history bounded
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
    }

    getAverageBaseFee(minutes = 10): string | null {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        const recent = this.history.filter(h => h.timestamp >= cutoff);

        if (recent.length === 0) return null;

        const avg = recent.reduce((sum, h) => sum + parseFloat(h.baseFee), 0) / recent.length;
        return avg.toFixed(2);
    }

    recommendSpeed(targetMaxFeeGwei: number): GasStrategy['speed'] {
        const avg = this.getAverageBaseFee();
        if (!avg) return 'standard';

        const avgBase = parseFloat(avg);
        const estimatedFast = avgBase * 1.2 + 5; // base * multiplier + priority fee

        if (estimatedFast <= targetMaxFeeGwei) return 'fast';
        if (avgBase * 1.0 + 2 <= targetMaxFeeGwei) return 'standard';
        return 'slow';
    }
}
