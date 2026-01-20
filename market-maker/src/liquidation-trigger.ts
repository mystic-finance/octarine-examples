/**
 * Manual Liquidation Trigger for Market Makers
 */

import { LimitOrder, SignatureType } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import { ethers, Wallet } from 'ethers';
import axios from 'axios';
import { approveTokenToExchangeProxy } from './approvals';
import { CONFIG } from './config';

// ============================================================================
// TYPES
// ============================================================================

interface Liquidation {
    _id: string;
    marketId: string;
    borrower: string;
    collateralAsset: string;
    debtAsset: string;
    collateralAmount: string;
    borrowedAmount: string;
    collateralAmountThatCanBeSeized: string;
    healthFactor: number;
    chainId: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    exchangeProxy: string;
    baseFeedPrice: number;
    borrowedPosition: {
        asset: {
            decimals: number;
            id: string;
            name: string;
            symbol: string;
        }
    }
    collateralPosition: {
        asset: {
            decimals: number;
            id: string;
            name: string;
            symbol: string;
        }
    }
}

interface LiquidationOrderInfo {
    chainId: number;
    verifyingContract: string;
    makerToken: string;
    takerToken: string;
    takerAmount: string;
    makerAmount: string;
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: number;
    salt: string;
}

interface Signature {
    signatureType: number;
    v: number;
    r: string;
    s: string;
}

interface TriggerLiquidationRequest {
    liquidationId: string;
    marketMaker: string;
    signature: Signature;
    debtAmountToLiquidate: number;
    orderInfo: any;
    expiry: number
}

// ============================================================================
// LOGIC
// ============================================================================

async function getOpenLiquidations(): Promise<Liquidation[]> {
    try {
        const params: any = {
            chainId: CONFIG.SUPPORTED_CHAINS[0], // Default to first supported chain
            limit: 1000
        };

        if (CONFIG.ACCEPTED_TOKENS && CONFIG.ACCEPTED_TOKENS.length > 0 && CONFIG.ACCEPTED_TOKENS[0] !== "*") {
            params.collateralAssets = CONFIG.ACCEPTED_TOKENS;
        }

        const response = await axios.get(
            `${CONFIG.API_BASE_URL}/octarine/liquidations/opportunities`,
            {
                params,
            },
        );

        const liquidations = response.data.data || [];
        console.log(`🔍 Found ${liquidations.length} open liquidations`);
        return liquidations;
    } catch (error: any) {
        console.error('❌ Failed to fetch liquidations:', error.response?.data || error.message);
        return [];
    }
}

function calculateLiquidationAmounts(
    liquidation: Liquidation,
): { debtToRepay: string; collateralToSeize: string; profit: string, collateralDecimals: number, decimals: number } {
    const debtAmount = new BigNumber(liquidation.borrowedAmount);
    const collateralAmount = new BigNumber(liquidation.collateralAmountThatCanBeSeized);

    if (!liquidation.collateralAmountThatCanBeSeized) {
        return {
            debtToRepay: '0', collateralToSeize: '0', profit: '0',
            collateralDecimals: 6, decimals: 6
        }
    }

    const maxLiquidationRatio = 0.8;
    const debtToRepay = debtAmount.multipliedBy(maxLiquidationRatio);
    const maxCollateralToSeize = collateralAmount.multipliedBy(maxLiquidationRatio);

    const decimals = liquidation.borrowedPosition.asset.decimals ?? 6;
    const collateralDecimals = liquidation.collateralPosition.asset.decimals ?? 6;

    // Your profit is roughly the bonus capture (simplified view)
    const profit = maxCollateralToSeize.minus(debtToRepay); // rough heuristic, depends on relative prices

    return {
        debtToRepay: (debtToRepay.multipliedBy(10 ** decimals)).integerValue().toString(),
        collateralToSeize: (maxCollateralToSeize.multipliedBy(10 ** collateralDecimals)).integerValue().toString(),
        profit: profit.toString(),
        decimals,
        collateralDecimals
    };
}

function calculateQuote(
    collateralToSeize: string,
    baseFeedPrice: number,
    collateralDecimals: number,
    debtDecimals: number,
    debtToken: string,
    collateralToken: string,
): string {
    const collateralAmount = new BigNumber(collateralToSeize);
    const debtValueWei = collateralAmount.multipliedBy(baseFeedPrice);

    // Apply spread for profit margin (Configurable?)
    // Using a fixed 1% profit margin for liquidations as per example, or could use CONFIG.PRICE_SPREAD
    // Example used 0.99.
    const spread = 0.99;
    const quote = debtValueWei.multipliedBy(spread).integerValue();

    return quote.toFixed(0);
}

function buildLiquidationOrderInfo(
    liquidation: Liquidation,
    amounts: { debtToRepay: string; collateralToSeize: string },
): LiquidationOrderInfo {
    const salt = Date.now().toString();
    const expiry = Math.floor(Date.now() / 1000) + (20 * 60); // 30 minutes

    const makerAmount = calculateQuote(
        amounts.collateralToSeize,
        liquidation.baseFeedPrice,
        liquidation.collateralPosition.asset.decimals,
        liquidation.borrowedPosition.asset.decimals,
        liquidation.borrowedPosition.asset.id,
        liquidation.collateralAsset,
    );

    return {
        chainId: liquidation.chainId,
        verifyingContract: liquidation.exchangeProxy,
        makerToken: liquidation.borrowedPosition.asset.id,
        takerToken: liquidation.collateralAsset,
        makerAmount: makerAmount,
        takerAmount: amounts.collateralToSeize,
        pool: '0x0000000000000000000000000000000000000000000000000000000000000000',
        sender: '0x0000000000000000000000000000000000000000',
        feeRecipient: '0x0000000000000000000000000000000000000000',
        takerTokenFeeAmount: '0',
        expiry,
        salt,
    };
}

async function signLiquidationOrder(
    orderInfo: LiquidationOrderInfo,
): Promise<{ order: any; signature: Signature }> {
    console.log('\n✍️  Signing liquidation order...');

    const makerAmount = new BigNumber((+orderInfo.makerAmount * 1.01).toFixed(0))
    const takerAmount = new BigNumber((+orderInfo.takerAmount * 1.01).toFixed(0));

    try {
        const order = new LimitOrder({
            chainId: orderInfo.chainId,
            verifyingContract: orderInfo.verifyingContract,
            maker: CONFIG.MARKET_MAKER_ADDRESS,
            taker: '0x0000000000000000000000000000000000000000',
            makerToken: orderInfo.makerToken,
            takerToken: orderInfo.takerToken,
            makerAmount: makerAmount,
            takerAmount: takerAmount,
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

        console.log('✅ Liquidation order signed successfully');

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
        console.error('❌ Failed to sign liquidation order:', error.message);
        throw error;
    }
}

async function triggerLiquidation(
    params: TriggerLiquidationRequest,
): Promise<void> {
    console.log(`\n🚀 Triggering liquidation ${params.liquidationId}...`);

    try {
        const response = await axios.post(
            `${CONFIG.API_BASE_URL}/redemptions/liquidations/bid`,
            params,
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {}),
                },
            },
        );

        console.log('✅ Liquidation triggered successfully!');
        console.log('Transaction hash:', response.data.txHash);
    } catch (error: any) {
        console.error('❌ Failed to trigger liquidation:', error.response?.data || error.message);
        throw error;
    }
}

function shouldLiquidate(
    liquidation: Liquidation,
    amounts: { debtToRepay: string; collateralToSeize: string },
): boolean {
    if (liquidation.healthFactor > 1.0) {
        console.log(`⏭️  Skipping ${liquidation._id}: position is healthy (HF: ${liquidation.healthFactor})`);
        return false;
    }

    // Check supported chains
    if (!CONFIG.SUPPORTED_CHAINS.includes(+liquidation.chainId)) {
        console.log(`⏭️  Skipping ${liquidation._id}: unsupported chain`);
        return false;
    }

    if (CONFIG.ACCEPTED_TOKENS[0] !== '*') {
        const redeemAsset = liquidation.collateralAsset.toLowerCase();
        const isSupported = CONFIG.ACCEPTED_TOKENS.some(t => t.toLowerCase() === redeemAsset);
        if (!isSupported) {
            console.log(`⏭️  Skipping ${liquidation._id}: unsupported token ${liquidation.collateralAsset}`);
            return false;
        }
    }


    return true;
}

async function processSingleLiquidation(liquidation: Liquidation): Promise<void> {
    try {
        console.log(`\n🎯 Processing liquidation ${liquidation._id}...`);

        const amounts = calculateLiquidationAmounts(liquidation);

        if (amounts.debtToRepay == '0' || amounts.collateralToSeize == '0') {
            console.log(`⏭️  Skipping ${liquidation._id}: no debt or collateral to seize`);
            return;
        }

        if (!shouldLiquidate(liquidation, amounts)) {
            return;
        }

        const orderInfo = buildLiquidationOrderInfo(liquidation, amounts);

        const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);
        await approveTokenToExchangeProxy(orderInfo.verifyingContract, orderInfo.makerAmount, orderInfo.makerToken, wallet);

        const { order, signature } = await signLiquidationOrder(orderInfo);

        await triggerLiquidation({
            liquidationId: liquidation._id,
            marketMaker: CONFIG.MARKET_MAKER_ADDRESS,
            signature,
            expiry: 20,
            orderInfo: order,
            debtAmountToLiquidate: +amounts.debtToRepay / 10 ** +amounts.decimals,
        });

        console.log(`✅ Successfully triggered liquidation ${liquidation._id}`);

    } catch (error: any) {
        console.error(`❌ Failed to process liquidation ${liquidation._id}:`, error.message);
    }
}

export async function startLiquidationMonitor(): Promise<void> {
    console.log('🚀 Starting Manual Liquidation Monitor');
    console.log('==========================================');
    console.log(`Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);

    const processedLiquidations = new Set<string>();

    while (true) {
        try {
            const liquidations = await getOpenLiquidations();

            for (const liquidation of liquidations) {
                if (processedLiquidations.has(liquidation._id)) {
                    continue;
                }
                await processSingleLiquidation(liquidation);
                processedLiquidations.add(liquidation._id);
            }

            if (processedLiquidations.size > 1000) {
                const toRemove = Array.from(processedLiquidations).slice(0, 500);
                toRemove.forEach(id => processedLiquidations.delete(id));
            }

        } catch (error: any) {
            console.error('❌ Error in liquidation monitor:', error.message);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.LIQUIDATION_POLL_INTERVAL_MS));
    }
}

if (require.main === module) {
    startLiquidationMonitor().catch((error) => {
        console.error('\n❌ Liquidation monitor crashed:', error.message);
        process.exit(1);
    });
}
