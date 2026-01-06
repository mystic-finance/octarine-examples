/**
 * Order signing utilities
 * Centralized LimitOrder signing for both RFQ and liquidation flows
 */

import { LimitOrder, SignatureType } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import { Wallet } from 'ethers';
import { Signature, SignedOrder, SerializedLimitOrder } from '../types';
import { createLogger } from './logger';

const logger = createLogger('signing');

export interface LimitOrderParams {
    chainId: number;
    verifyingContract: string;
    maker: string;
    taker: string;
    makerToken: string;
    takerToken: string;
    makerAmount: string;
    takerAmount: string;
    pool?: string;
    sender?: string;
    feeRecipient?: string;
    takerTokenFeeAmount?: string;
    expiry: number;
    salt?: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Sign a LimitOrder and return both the order and signature
 */
export async function signLimitOrder(
    params: LimitOrderParams,
    wallet: Wallet,
): Promise<SignedOrder> {
    logger.debug('Signing limit order', {
        chainId: params.chainId,
        maker: params.maker,
        makerAmount: params.makerAmount,
        takerAmount: params.takerAmount,
    });

    const salt = params.salt || Date.now().toString();

    const order = new LimitOrder({
        chainId: params.chainId,
        verifyingContract: params.verifyingContract,
        maker: params.maker,
        taker: params.taker,
        makerToken: params.makerToken,
        takerToken: params.takerToken,
        makerAmount: new BigNumber(params.makerAmount),
        takerAmount: new BigNumber(params.takerAmount),
        pool: params.pool || ZERO_BYTES32,
        sender: params.sender || ZERO_ADDRESS,
        feeRecipient: params.feeRecipient || ZERO_ADDRESS,
        takerTokenFeeAmount: new BigNumber(params.takerTokenFeeAmount || '0'),
        expiry: new BigNumber(params.expiry),
        salt: new BigNumber(salt),
    });

    const signature = await order.getSignatureWithKey(
        wallet.privateKey,
        SignatureType.EIP712,
    );

    const serializedOrder: SerializedLimitOrder = {
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
    };

    logger.debug('Order signed successfully', {
        chainId: params.chainId,
        salt,
    });

    return {
        order: serializedOrder,
        signature: signature as Signature,
    };
}

/**
 * Generate a cryptographically secure salt
 * Falls back to Date.now() if crypto is not available
 */
export function generateSalt(): string {
    try {
        const randomBytes = require('crypto').randomBytes(32);
        return new BigNumber('0x' + randomBytes.toString('hex')).toString();
    } catch {
        return Date.now().toString();
    }
}

/**
 * Calculate expiry timestamp from minutes
 */
export function calculateExpiry(minutesFromNow: number): number {
    return Math.floor(Date.now() / 1000) + (minutesFromNow * 60);
}
