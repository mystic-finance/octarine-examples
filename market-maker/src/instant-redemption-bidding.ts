/**
 * Manual RFQ Bidding for Instant Redemptions
 */

import { LimitOrder, SignatureType } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import { Wallet, ethers } from 'ethers';
import axios from 'axios';
import { approveTokenToExchangeProxy } from './approvals';
import { CONFIG } from './config';

// ============================================================================
// TYPES
// ============================================================================

interface RFQRequest {
    requestId: string;
    user: string;
    redeemAsset: string; // Token user is giving (we receive)
    redemptionAsset: string; // Token user wants (we provide)
    redeemAmount: string;
    chainId: number;
    status: 'Pending' | 'Bidding' | 'Solved' | 'Cancelled';
    expiry: number;
    metadata?: {
        rfqOrder?: RFQOrderFromMetadata;
    };
    createdAt: string;
}

interface RFQOrderFromMetadata {
    chainId: number;
    verifyingContract: string;
    makerToken: string;
    takerToken: string;
    takerAmount: string;
    taker: string;
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: number;
    salt: number;
}

interface Signature {
    signatureType: number;
    v: number;
    r: string;
    s: string;
}

interface SubmitBidRequest {
    requestId: string;
    maker: string;
    makerAmount: string;
    expiry: number;
    signature: Signature;
    activeFrom?: number;
}

// ============================================================================
// STEP 1: GET PENDING RFQ REQUESTS
// ============================================================================

async function getPendingRequests(): Promise<RFQRequest[]> {
    try {
        const response = await axios.get(
            `${CONFIG.API_BASE_URL}/octarine/requests`,
            {
                params: {
                    status: 'pending,bidding',
                    // chainId: 98866, // Can filter by chain if needed
                    marketMaker: CONFIG.MARKET_MAKER_ADDRESS
                },
            },
        );

        const requests = response.data.data || [];
        console.log(`📋 Found ${requests.length} pending instant redemption requests`);

        return requests;
    } catch (error: any) {
        console.error('❌ Failed to fetch requests:', error.response?.data || error.message);
        return [];
    }
}

// ============================================================================
// STEP 2: SIGN LIMIT ORDER FROM REQUEST METADATA
// ============================================================================

async function signRFQOrder(
    rfqRequest: RFQRequest,
    makerAmount: string, // Your quote amount
): Promise<{ order: any; signature: Signature }> {
    console.log(`\n✍️  Signing order for request ${rfqRequest.requestId}...`);

    const base = rfqRequest?.metadata?.rfqOrder;
    if (!base) {
        throw new Error('metadata.rfqOrder missing from RFQ request');
    }

    try {
        // Create LimitOrder from metadata
        const order = new LimitOrder({
            chainId: base.chainId,
            verifyingContract: base.verifyingContract,
            makerToken: base.makerToken,
            takerToken: base.takerToken,
            makerAmount: new BigNumber(makerAmount), // Your quote
            takerAmount: new BigNumber(base.takerAmount), // User's amount
            maker: CONFIG.MARKET_MAKER_ADDRESS, // Your address
            taker: base.taker,
            pool: base.pool,
            sender: base.sender,
            feeRecipient: base.feeRecipient,
            takerTokenFeeAmount: new BigNumber(String(base.takerTokenFeeAmount)),
            expiry: new BigNumber(base.expiry),
            salt: new BigNumber(base.salt),
        });

        // Sign with your private key
        const wallet = new Wallet(CONFIG.PRIVATE_KEY);
        const signature = await order.getSignatureWithKey(
            wallet.privateKey,
            SignatureType.EIP712,
        );

        console.log('✅ Order signed successfully');

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
        console.error('❌ Failed to sign order:', error.message);
        throw error;
    }
}

// ============================================================================
// STEP 3: SUBMIT BID (QUOTE)
// ============================================================================

async function submitBid(
    params: SubmitBidRequest,
): Promise<void> {
    console.log(`\n📤 Submitting bid for request ${params.requestId}...`);

    try {
        const response = await axios.post(
            `${CONFIG.API_BASE_URL}/octarine/bid`,
            params,
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {}),
                },
            },
        );

        console.log('✅ Bid submitted successfully!');
        console.log('Bid ID:', response.data.data.bidId);
    } catch (error: any) {
        console.error('❌ Failed to submit bid:', error.response?.data || error.message);
        throw error;
    }
}

// ============================================================================
// PRICING LOGIC
// ============================================================================

function calculateQuote(request: RFQRequest): string {
    const takerAmount = new BigNumber(request.redeemAmount);

    // Pricing Logic from CONFIG
    const spread = CONFIG.PRICE_SPREAD;
    const quote = takerAmount.multipliedBy(spread).integerValue();

    console.log(`💰 Pricing for request ${request.requestId}:`);
    console.log(`   User wants: ${request.redeemAmount} ${request.redemptionAsset}`);
    console.log(`   Your quote: ${quote.toString()} ${request.redeemAsset}`);
    console.log(`   Spread: ${(1 - spread) * 100}%`);

    return quote.toString();
}

/**
 * Decide if you want to bid on this request
 */
function shouldBidOnRequest(request: RFQRequest): boolean {
    // 1. Check supported tokens (if defined)
    if (CONFIG.ACCEPTED_TOKENS[0] !== '*') {
        const redeemAsset = request.redeemAsset.toLowerCase();
        const isSupported = CONFIG.ACCEPTED_TOKENS.some(t => t.toLowerCase() === redeemAsset);
        if (!isSupported) {
            console.log(`⏭️  Skipping request ${request.requestId}: unsupported token ${request.redeemAsset}`);
            return false;
        }
    }

    // 2. Check minimum amount
    const minAmount = new BigNumber(CONFIG.MIN_BID_AMOUNT_WEI);
    if (new BigNumber(request.redeemAmount).isLessThan(minAmount)) {
        console.log(`⏭️  Skipping request ${request.requestId}: amount too small`);
        return false;
    }

    // 3. Check chain
    if (!CONFIG.SUPPORTED_CHAINS.includes(request.chainId)) {
        console.log(`⏭️  Skipping request ${request.requestId}: unsupported chain ${request.chainId}`);
        return false;
    }

    // 4. Check expiration
    const timeLeft = request.expiry - Math.floor(Date.now() / 1000);
    if (timeLeft < 30) {
        console.log(`⏭️  Skipping request ${request.requestId}: expiring soon`);
        return false;
    }

    return true;
}

// ============================================================================
// STEP 4: MONITOR & TRANSFORM WON BIDS
// ============================================================================

async function callTransform(requestId: string): Promise<void> {
    console.log(`\n🔄 Calling transform for request ${requestId}...`);

    try {
        const response = await axios.post(
            `${CONFIG.API_BASE_URL}/octarine/transform`,
            { requestId },
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(CONFIG.API_KEY ? { 'x-api-key': CONFIG.API_KEY } : {}),
                },
            },
        );

        console.log(`✅ Transform triggered successfully for ${requestId}`);
        if (response.data.txHash) {
            console.log(`   TxHash: ${response.data.txHash}`);
        }
    } catch (error: any) {
        if (error.response?.data?.message === 'Already executed') {
            console.log(`ℹ️  Transform already executed for ${requestId}`);
            return;
        }
        console.error('❌ Failed to trigger transform:', error.response?.data || error.message);
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// BALANCE CHECK
// ============================================================================

const ERC20_BALANCE_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
];

/**
 * Check if the wallet has sufficient balance of the maker token to fulfill the bid
 */
async function checkSufficientBalance(
    makerToken: string,
    makerAmount: string,
    wallet: Wallet,
): Promise<boolean> {
    try {
        const tokenContract = new ethers.Contract(makerToken, ERC20_BALANCE_ABI, wallet);
        const balance: ethers.BigNumber = await tokenContract.balanceOf(wallet.address);
        const requiredAmount = ethers.BigNumber.from(makerAmount);

        if (balance.lt(requiredAmount)) {
            console.log(`⏭️  Insufficient balance for bid:`);
            console.log(`   Required: ${makerAmount}`);
            console.log(`   Available: ${balance.toString()}`);
            console.log(`   Token: ${makerToken}`);
            return false;
        }

        console.log(`✅ Balance check passed: ${balance.toString()} >= ${makerAmount}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Failed to check balance:`, error.message);
        return false;
    }
}

async function monitorWonBids(processedRequests: Set<string>): Promise<void> {
    try {
        await delay(5000); // Check every few seconds

        const response = await axios.get(
            `${CONFIG.API_BASE_URL}/octarine/market-maker/${CONFIG.MARKET_MAKER_ADDRESS}/bids`,
            {
                params: {
                    status: 'accepted',
                    limit: 20
                },
            },
        );

        const wonBids = response.data.bids || [];

        for (const bid of wonBids) {
            if (processedRequests.has(`transform-${bid.requestId}`)) {
                continue;
            }

            console.log(`🎉 Bid won for request ${bid.requestId}! Triggering transform...`);
            await callTransform(bid.requestId);
            processedRequests.add(`transform-${bid.requestId}`);
        }

    } catch (error: any) {
        console.warn('⚠️  Failed to check won bids:', error.message);
    }
}

// ============================================================================
// MAIN BIDDING FLOW
// ============================================================================

async function processSingleRequest(request: RFQRequest): Promise<void> {
    try {
        console.log(`\n🎯 Processing request ${request.requestId}...`);

        if (!shouldBidOnRequest(request)) {
            return;
        }

        const makerAmount = calculateQuote(request);

        // Setup wallet and provider
        const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);

        // Check if we have sufficient balance to fulfill the bid
        const makerToken = request.metadata?.rfqOrder?.makerToken ?? '';
        const hasSufficientBalance = await checkSufficientBalance(makerToken, makerAmount, wallet);
        if (!hasSufficientBalance) {
            console.log(`⏭️  Skipping request ${request.requestId}: insufficient balance`);
            return;
        }

        // Approve token if needed
        await approveTokenToExchangeProxy(
            request.metadata?.rfqOrder?.verifyingContract ?? '',
            makerAmount,
            request.metadata?.rfqOrder?.makerToken ?? '', // We are confirming approval for TOKEN WE PROVIDE
            wallet
        );

        // Sign and submit
        const { signature } = await signRFQOrder(request, makerAmount);

        await submitBid({
            requestId: request.requestId,
            maker: CONFIG.MARKET_MAKER_ADDRESS,
            makerAmount,
            expiry: 60, // Bid valid for 60 minutes relative to now? Or match request expiry? 
            // In example it was hardcoded 60. Let's keep it simple.
            signature,
            activeFrom: 0,
        });

        console.log(`✅ Successfully bid on request ${request.requestId}`);

    } catch (error: any) {
        console.error(`❌ Failed to process request ${request.requestId}:`, error.message);
    }
}

export async function startBiddingLoop(): Promise<void> {
    console.log('🚀 Starting Instant Redemption Bidding Bot');
    console.log('==========================================');
    console.log(`Market Maker: ${CONFIG.MARKET_MAKER_ADDRESS}`);
    console.log(`Spread: ${(1 - CONFIG.PRICE_SPREAD) * 100}%`);
    console.log('==========================================\n');

    const processedRequests = new Set<string>();

    while (true) {
        try {
            // 1. Get pending requests
            const requests = await getPendingRequests();

            for (const request of requests) {
                if (processedRequests.has(request.requestId)) {
                    continue;
                }
                await processSingleRequest(request);
                processedRequests.add(request.requestId);
            }

            // 2. Monitor for Won Bids & Transform
            await monitorWonBids(processedRequests);

            // Clean up memory
            if (processedRequests.size > 1000) {
                const requestIds = Array.from(processedRequests).filter(id => !id.startsWith('transform-'));
                if (requestIds.length > 500) {
                    requestIds.slice(0, 500).forEach(id => processedRequests.delete(id));
                }
            }

        } catch (error: any) {
            console.error('❌ Error in bidding loop:', error.message);
        }

        await delay(CONFIG.BIDDING_POLL_INTERVAL_MS);
    }
}

if (require.main === module) {
    startBiddingLoop().catch((error) => {
        console.error('\n❌ Bidding bot crashed:', error.message);
        process.exit(1);
    });
}
