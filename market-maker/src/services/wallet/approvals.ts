/**
 * Token approval utilities using WalletManager
 */

import { ethers } from 'ethers';
import { WalletManager, getWalletManager } from './index';
import { createLogger } from '../../utils/logger';

const logger = createLogger('approvals');

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

export interface ApprovalResult {
    txHash: string | null;
    alreadyApproved: boolean;
}

/**
 * Approve token to exchange proxy with proper error handling
 */
export async function approveTokenToExchangeProxy(
    exchangeProxy: string,
    amount: string,
    token: string,
    walletManager?: WalletManager,
): Promise<ApprovalResult> {
    const wm = walletManager || getWalletManager();
    const wallet = wm.getWallet();
    const provider = wm.getProvider();

    if (!exchangeProxy || exchangeProxy === ethers.constants.AddressZero) {
        throw new Error('Invalid exchange proxy address');
    }

    if (!token || token === ethers.constants.AddressZero) {
        throw new Error('Invalid token address');
    }

    const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);

    try {
        // Get token symbol for logging
        let symbol = 'UNKNOWN';
        try {
            symbol = await erc20.symbol();
        } catch {
            // Some tokens don't have symbol
        }

        const owner = await wallet.getAddress();
        const currentAllowance = await erc20.allowance(owner, exchangeProxy);

        // Use BigNumber comparison to avoid precision issues
        const requiredAmount = ethers.BigNumber.from(amount);
        if (currentAllowance.gte(requiredAmount)) {
            logger.debug('Token already approved', {
                token: symbol,
                currentAllowance: currentAllowance.toString(),
                required: amount,
            });
            return { txHash: null, alreadyApproved: true };
        }

        logger.info('Approving token', {
            token: symbol,
            spender: exchangeProxy,
            amount: 'unlimited',
        });

        // Use WalletManager for nonce management
        const tx = await wm.sendTransaction({
            to: token,
            data: erc20.interface.encodeFunctionData('approve', [
                exchangeProxy,
                ethers.constants.MaxUint256,
            ]),
        });

        logger.debug('Approval transaction sent', { txHash: tx.hash });

        const receipt = await wm.waitForTransaction(tx.hash);

        logger.info('Token approved', {
            token: symbol,
            txHash: receipt.transactionHash,
        });

        return { txHash: receipt.transactionHash, alreadyApproved: false };
    } catch (error) {
        logger.error('Failed to approve token', error instanceof Error ? error : new Error(String(error)), {
            token,
            exchangeProxy,
        });
        throw error;
    }
}

/**
 * Check if token is approved for the required amount
 */
export async function isTokenApproved(
    exchangeProxy: string,
    amount: string,
    token: string,
    walletManager?: WalletManager,
): Promise<boolean> {
    const wm = walletManager || getWalletManager();
    const wallet = wm.getWallet();

    const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);
    const owner = await wallet.getAddress();
    const currentAllowance = await erc20.allowance(owner, exchangeProxy);

    return currentAllowance.gte(ethers.BigNumber.from(amount));
}
