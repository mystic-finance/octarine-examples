/**
 * API request and response type definitions
 */

import { RFQOrderFromMetadata, Signature, SerializedLimitOrder } from './orders';

// ============================================================================
// RFQ Types
// ============================================================================

export type RFQStatus = 'Pending' | 'Bidding' | 'Solved' | 'Cancelled';

export interface RFQRequest {
    requestId: string;
    user: string;
    redeemAsset: string;
    redemptionAsset: string;
    redeemAmount: string;
    chainId: number;
    status: RFQStatus;
    expiry: number;
    metadata?: {
        rfqOrder?: RFQOrderFromMetadata;
    };
    createdAt: string;
}

export interface SubmitBidRequest {
    requestId: string;
    maker: string;
    makerAmount: string;
    expiry: number;
    signature: Signature;
    activeFrom?: number;
}

export interface BidResponse {
    bidId: string;
}

export interface WonBid {
    requestId: string;
    bidId: string;
    maker: string;
    makerAmount: string;
    status: string;
}

// ============================================================================
// Liquidation Types
// ============================================================================

export type LiquidationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AssetInfo {
    decimals: number;
    id: string;
    name: string;
    symbol: string;
}

export interface AssetPosition {
    asset: AssetInfo;
}

export interface Liquidation {
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
    status: LiquidationStatus;
    exchangeProxy: string;
    baseFeedPrice: number;
    borrowedPosition: AssetPosition;
    collateralPosition: AssetPosition;
}

export interface TriggerLiquidationRequest {
    liquidationId: string;
    marketMaker: string;
    signature: Signature;
    debtAmountToLiquidate: number;
    orderInfo: SerializedLimitOrder;
    expiry: number;
}

export interface LiquidationAmounts {
    debtToRepay: string;
    collateralToSeize: string;
    profit: string;
    collateralDecimals: number;
    decimals: number;
}

// ============================================================================
// Generic API Response Types
// ============================================================================

export interface ApiResponse<T> {
    data: T;
    message?: string;
}

export interface ApiError {
    response?: {
        status?: number;
        data?: {
            message?: string;
            error?: string;
            [key: string]: unknown;
        };
    };
    message: string;
    code?: string;
}
