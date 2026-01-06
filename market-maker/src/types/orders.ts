/**
 * Order-related type definitions
 * Shared between RFQ bidding and liquidation flows
 */

export interface Signature {
    signatureType: number;
    v: number;
    r: string;
    s: string;
}

export interface BaseOrderInfo {
    chainId: number;
    verifyingContract: string;
    makerToken: string;
    takerToken: string;
    makerAmount: string;
    takerAmount: string;
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: number;
    salt: string;
}

export interface RFQOrderFromMetadata extends BaseOrderInfo {
    taker: string;
}

export interface LiquidationOrderInfo extends BaseOrderInfo {}

export interface SerializedLimitOrder {
    chainId: number;
    verifyingContract: string;
    makerToken: string;
    takerToken: string;
    makerAmount: string;
    takerAmount: string;
    maker: string;
    taker: string;
    pool: string;
    sender: string;
    feeRecipient: string;
    takerTokenFeeAmount: string;
    expiry: string;
    salt: string;
}

export interface SignedOrder {
    order: SerializedLimitOrder;
    signature: Signature;
}
