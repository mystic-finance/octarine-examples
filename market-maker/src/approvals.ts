/**
 * Token Approval Management
 * 
 * Handles ERC20 token approvals for the Octarine Exchange Proxy.
 * All token transfers in the Octarine protocol require pre-approval of the 
 * Exchange Proxy contract as a spender.
 * 
 * Gas Optimization:
 * - Uses unlimited approvals (type(uint256).max) to minimize future approval transactions
 * - Checks existing allowance before submitting approval to save gas
 * - Can be disabled via AUTO_APPROVE_TOKENS config if manual approval is preferred
 */

import { ethers } from 'ethers';
import { logger } from './utils/logger';
import { retry } from './utils/retry';
import { CONFIG } from './config';

/**
 * Standard ERC20 ABI for approval operations
 */
const ERC20_ABI = [
    /**
     * @notice Approve spender to transfer up to `amount` tokens
     * @param spender The address authorized to spend
     * @param amount The maximum amount allowed (type(uint256).max for unlimited)
     * @return success Whether the approval succeeded
     */
    'function approve(address spender, uint256 amount) external returns (bool)',
    
    /**
     * @notice Check remaining allowance
     * @param owner The token owner
     * @param spender The authorized spender
     * @return remaining Amount still allowed
     */
    'function allowance(address owner, address spender) view returns (uint256)',
    
    /**
     * @notice Get token decimals for amount formatting
     * @return decimals Number of decimal places
     */
    'function decimals() view returns (uint8)',
    
    /**
     * @notice Get token balance
     * @param account The account to query
     * @return balance Token balance
     */
    'function balanceOf(address account) view returns (uint256)',
    
    /**
     * @notice Get token symbol
     * @return symbol Token symbol (e.g., "USDC")
     */
    'function symbol() view returns (string)',
];

/**
 * Result of an approval operation
 */
export interface ApprovalResult {
    /** Transaction hash if approval was executed, null if skipped */
    txHash: string | null;
    /** Whether sufficient allowance already existed */
    alreadyApproved: boolean;
    /** Token contract address */
    token: string;
    /** Spender address that was approved */
    spender: string;
}

/**
 * Approve the Exchange Proxy to spend tokens on behalf of the market maker.
 * 
 * @param exchangeProxy - The Octarine Exchange Proxy contract address
 * @param amount - The amount that needs to be approved (for comparison with existing allowance)
 * @param token - The ERC20 token address
 * @param signer - Ethers signer for transaction submission
 * @returns ApprovalResult with transaction details
 * 
 * @example
 * ```typescript
 * const result = await approveTokenToExchangeProxy(
 *   '0xExchangeProxy...',
 *   '1000000000000000000', // 1 token
 *   '0xTokenAddress...',
 *   wallet
 * );
 * 
 * if (result.alreadyApproved) {
 *   console.log('Token already approved');
 * } else {
 *   console.log(`Approval tx: ${result.txHash}`);
 * }
 * ```
 */
export async function approveTokenToExchangeProxy(
    exchangeProxy: string,
    amount: string,
    token: string,
    signer: ethers.Signer,
): Promise<ApprovalResult> {
    // Validate inputs
    if (!exchangeProxy || exchangeProxy === '0x0000000000000000000000000000000000000000') {
        throw new Error('Invalid exchangeProxy address: must be a valid non-zero address');
    }

    if (!token || token === '0x0000000000000000000000000000000000000000') {
        throw new Error('Invalid token address: must be a valid non-zero address');
    }

    if (!amount || BigInt(amount) <= 0) {
        throw new Error('Invalid amount: must be positive');
    }

    const owner = await signer.getAddress();

    logger.debug('Checking token allowance', {
        token,
        owner: owner.slice(0, 10) + '...',
        spender: exchangeProxy.slice(0, 10) + '...',
        requiredAmount: amount,
    });

    // Create token contract instance
    const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);

    // Fetch token info for logging
    let tokenSymbol: string;
    let tokenDecimals: number;
    try {
        [tokenSymbol, tokenDecimals] = await Promise.all([
            tokenContract.symbol().catch(() => 'UNKNOWN'),
            tokenContract.decimals().catch(() => 18),
        ]);
    } catch (error) {
        logger.warn('Failed to fetch token metadata, using defaults', { token });
        tokenSymbol = 'UNKNOWN';
        tokenDecimals = 18;
    }

    // Check current allowance
    const currentAllowance: ethers.BigNumber = await retry(
        () => tokenContract.allowance(owner, exchangeProxy),
        { context: { operation: 'checkAllowance', token } }
    );

    const requiredAmount = ethers.BigNumber.from(amount);

    // If allowance already covers the required amount, skip approval
    // Using gt (greater than) with a buffer for safety
    const safetyBuffer = requiredAmount.mul(5); // 5x buffer for future operations
    
    if (currentAllowance.gt(safetyBuffer)) {
        logger.info(`Token ${tokenSymbol} already approved (allowance: ${currentAllowance.toString()})`, {
            token,
            tokenSymbol,
            alreadyApproved: true,
        });
        
        return {
            txHash: null,
            alreadyApproved: true,
            token,
            spender: exchangeProxy,
        };
    }

    // Check if auto-approval is disabled
    if (!CONFIG.BIDDING.autoApproveTokens) {
        throw new Error(
            `Token ${token} (${tokenSymbol}) requires approval but AUTO_APPROVE_TOKENS is disabled. ` +
            `Please approve manually or enable auto-approval in config.`
        );
    }

    logger.info(`Approving ${tokenSymbol} for Exchange Proxy`, {
        token,
        tokenSymbol,
        spender: exchangeProxy,
        currentAllowance: currentAllowance.toString(),
        requiredAmount: requiredAmount.toString(),
    });

    // Submit approval transaction with unlimited amount
    // This is a gas optimization - one approval covers all future transactions
    const unlimitedAmount = ethers.constants.MaxUint256;

    const tx = await retry(
        async () => {
            const transaction = await tokenContract.approve(exchangeProxy, unlimitedAmount);
            logger.debug('Approval transaction submitted', {
                token: tokenSymbol,
                hash: transaction.hash,
            });
            return transaction;
        },
        {
            maxRetries: 3,
            context: { operation: 'approveToken', token, tokenSymbol },
        }
    );

    // Wait for confirmation
    logger.debug('Waiting for approval confirmation...', { hash: tx.hash });
    
    const receipt = await retry(
        () => tx.wait(1), // Wait for 1 confirmation
        {
            maxRetries: 5,
            initialDelayMs: 2000,
            context: { operation: 'waitForApproval', hash: tx.hash },
        }
    );

    logger.success('Token approval confirmed', receipt.confirmations * 1000, {
        token: tokenSymbol,
        hash: receipt.transactionHash,
        gasUsed: receipt.gasUsed.toString(),
    });

    return {
        txHash: receipt.transactionHash,
        alreadyApproved: false,
        token,
        spender: exchangeProxy,
    };
}

/**
 * Check if a token approval exists without submitting a transaction.
 * Useful for pre-flight checks before attempting an operation.
 * 
 * @param token - ERC20 token address
 * @param owner - Token owner address
 * @param spender - Authorized spender address
 * @param provider - Ethers provider for read operations
 * @param requiredAmount - Minimum required allowance
 * @returns Whether the approval exists and covers the required amount
 */
export async function checkTokenApproval(
    token: string,
    owner: string,
    spender: string,
    provider: ethers.providers.Provider,
    requiredAmount: string
): Promise<boolean> {
    try {
        const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
        const allowance: ethers.BigNumber = await tokenContract.allowance(owner, spender);
        const required = ethers.BigNumber.from(requiredAmount);
        
        return allowance.gte(required);
    } catch (error: any) {
        logger.error('Failed to check token approval', { token, owner, spender }, error);
        return false;
    }
}

/**
 * Batch check approvals for multiple tokens.
 * Returns a map of token addresses to approval status.
 */
export async function checkMultipleApprovals(
    tokens: Array<{ token: string; requiredAmount: string }>,
    owner: string,
    spender: string,
    provider: ethers.providers.Provider
): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    
    await Promise.all(
        tokens.map(async ({ token, requiredAmount }) => {
            const approved = await checkTokenApproval(
                token,
                owner,
                spender,
                provider,
                requiredAmount
            );
            results.set(token, approved);
        })
    );
    
    return results;
}
