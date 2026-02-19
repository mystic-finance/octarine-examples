/**
 * Web3 Token Approval Utilities
 * 
 * Handles ERC20 token approvals for the Octarine Exchange Proxy.
 * Token approvals are required before the protocol can transfer tokens on 
 * behalf of the user during swaps.
 * 
 * ## How Token Approvals Work
 * 
 * 1. User wants to swap Token A for Token B
 * 2. User must first approve the Exchange Proxy to spend Token A
 * 3. This is a one-time approval (or unlimited for gas efficiency)
 * 4. After approval, swaps can execute without additional approvals
 * 
 * ## Security Note
 * 
 * Unlimited approvals (type(uint256).max) are more gas-efficient since you
 * only pay approval gas once. However, use caution and only approve trusted
 * protocols. Revoke approvals when no longer needed.
 */

import { ethers, Signer, Contract } from 'ethers';

// ============================================================================
// ABI DEFINITIONS
// ============================================================================

/**
 * Minimal ERC20 ABI for approval operations
 */
const ERC20_ABI = [
    // Read functions
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    
    // Write functions
    'function approve(address spender, uint256 amount) returns (bool)',
    
    // Events
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Result of an approval operation
 */
export interface ApprovalResult {
    /** Transaction hash if a new approval was submitted */
    txHash: string | null;
    /** Whether sufficient allowance already existed */
    alreadyApproved: boolean;
    /** Current allowance amount */
    allowance: string;
}

/**
 * Token information
 */
export interface TokenInfo {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: string;
}

// ============================================================================
// APPROVAL FUNCTIONS
// ============================================================================

/**
 * Approve a spender (typically the Exchange Proxy) to spend tokens.
 * 
 * This function:
 * 1. Checks if approval already exists
 * 2. Submits approval transaction if needed
 * 3. Waits for confirmation
 * 4. Returns the result
 * 
 * @param spender - Address to approve (e.g., Exchange Proxy)
 * @param amount - Minimum amount needed (for comparison with existing allowance)
 * @param tokenAddress - ERC20 token contract address
 * @param signer - Ethers signer for transaction
 * @returns Approval result with transaction details
 * 
 * @example
 * ```typescript
 * const result = await approveToken(
 *   '0xExchangeProxy...',
 *   '1000000000000000000', // 1 token
 *   '0xTokenAddress...',
 *   signer
 * );
 * 
 * if (result.alreadyApproved) {
 *   console.log('Token already approved');
 * } else {
 *   console.log(`Approval confirmed: ${result.txHash}`);
 * }
 * ```
 */
export async function approveToken(
    spender: string,
    amount: string,
    tokenAddress: string,
    signer: Signer
): Promise<ApprovalResult> {
    // Validate inputs
    if (!spender || spender === ethers.constants.AddressZero) {
        throw new Error('Invalid spender address');
    }
    if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
        throw new Error('Invalid token address');
    }

    // Create token contract instance
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, signer);

    // Get connected wallet address
    const owner = await signer.getAddress();

    // Check current allowance
    let currentAllowance: ethers.BigNumber;
    try {
        currentAllowance = await tokenContract.allowance(owner, spender);
    } catch (error: any) {
        console.error('[Approval] Failed to check allowance:', error.message);
        throw new Error(`Could not check token allowance: ${error.message}`);
    }

    const requiredAmount = ethers.BigNumber.from(amount);

    // Calculate safety buffer (2x the required amount for future swaps)
    // This minimizes the frequency of approval transactions
    const safetyBuffer = requiredAmount.mul(2);

    // Check if existing allowance is sufficient
    if (currentAllowance.gt(safetyBuffer)) {
        console.log('[Approval] Token already approved with sufficient allowance', {
            current: currentAllowance.toString(),
            required: requiredAmount.toString(),
        });

        return {
            txHash: null,
            alreadyApproved: true,
            allowance: currentAllowance.toString(),
        };
    }

    // Need to approve - submit unlimited approval for gas efficiency
    console.log('[Approval] Submitting approval transaction...', {
        token: tokenAddress.slice(0, 10) + '...',
        spender: spender.slice(0, 10) + '...',
    });

    try {
        // Use MaxUint256 for unlimited approval (gas efficient)
        // This means you only need to approve once per token
        const unlimitedAmount = ethers.constants.MaxUint256;

        const tx = await tokenContract.approve(spender, unlimitedAmount);
        console.log('[Approval] Transaction submitted:', tx.hash);

        // Wait for confirmation
        const receipt = await tx.wait(1);

        console.log('[Approval] Transaction confirmed:', {
            hash: receipt.transactionHash,
            gasUsed: receipt.gasUsed.toString(),
        });

        return {
            txHash: receipt.transactionHash,
            alreadyApproved: false,
            allowance: unlimitedAmount.toString(),
        };

    } catch (error: any) {
        console.error('[Approval] Transaction failed:', error.message);

        // Provide user-friendly error messages
        if (error.code === 'ACTION_REJECTED') {
            throw new Error('Approval rejected by user');
        }
        if (error.code === 'INSUFFICIENT_FUNDS') {
            throw new Error('Insufficient ETH for gas fees');
        }

        throw new Error(`Approval failed: ${error.message}`);
    }
}

/**
 * Check the current token allowance without submitting a transaction.
 * 
 * @param tokenAddress - ERC20 token contract address
 * @param spender - Spender address (e.g., Exchange Proxy)
 * @param signer - Ethers signer or provider
 * @returns Current allowance as string (in token's smallest unit)
 */
export async function checkAllowance(
    tokenAddress: string,
    spender: string,
    signer: Signer
): Promise<string> {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, signer);
    const owner = await signer.getAddress();
    const allowance = await tokenContract.allowance(owner, spender);
    return allowance.toString();
}

/**
 * Check if a token approval is sufficient for a given amount.
 * 
 * @param tokenAddress - ERC20 token contract address
 * @param spender - Spender address
 * @param requiredAmount - Amount needed (in wei)
 * @param signer - Ethers signer
 * @returns True if allowance is sufficient
 */
export async function isTokenApproved(
    tokenAddress: string,
    spender: string,
    requiredAmount: string,
    signer: Signer
): Promise<boolean> {
    try {
        const allowanceStr = await checkAllowance(tokenAddress, spender, signer);
        const allowance = ethers.BigNumber.from(allowanceStr);
        const required = ethers.BigNumber.from(requiredAmount);
        return allowance.gte(required);
    } catch (error) {
        return false;
    }
}

/**
 * Get token information and balance.
 * 
 * @param tokenAddress - ERC20 token contract address
 * @param signer - Ethers signer
 * @returns Token information including symbol, decimals, and balance
 */
export async function getTokenInfo(
    tokenAddress: string,
    signer: Signer
): Promise<TokenInfo> {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, signer);
    const owner = await signer.getAddress();

    try {
        const [symbol, name, decimals, balance] = await Promise.all([
            tokenContract.symbol(),
            tokenContract.name(),
            tokenContract.decimals(),
            tokenContract.balanceOf(owner),
        ]);

        return {
            address: tokenAddress,
            symbol,
            name,
            decimals,
            balance: balance.toString(),
        };
    } catch (error: any) {
        console.error('[Token] Failed to get token info:', error.message);
        throw new Error(`Could not fetch token information: ${error.message}`);
    }
}

/**
 * Format a token amount from wei to human-readable format.
 * 
 * @param amount - Amount in wei (smallest unit)
 * @param decimals - Token decimals (default: 18)
 * @returns Formatted string
 * 
 * @example
 * ```typescript
 * formatTokenAmount('1000000000000000000', 18); // '1.0'
 * formatTokenAmount('1000000', 6);              // '1.0'
 * ```
 */
export function formatTokenAmount(amount: string, decimals: number = 18): string {
    try {
        return ethers.utils.formatUnits(amount, decimals);
    } catch (error) {
        return '0';
    }
}

/**
 * Parse a human-readable amount to wei.
 * 
 * @param amount - Human-readable amount (e.g., "1.5")
 * @param decimals - Token decimals (default: 18)
 * @returns Amount in wei as string
 * 
 * @example
 * ```typescript
 * parseTokenAmount('1.5', 18); // '1500000000000000000'
 * parseTokenAmount('100', 6);  // '100000000'
 * ```
 */
export function parseTokenAmount(amount: string, decimals: number = 18): string {
    try {
        return ethers.utils.parseUnits(amount, decimals).toString();
    } catch (error) {
        return '0';
    }
}

/**
 * Revoke token approval by setting allowance to 0.
 * Use this to remove approvals for tokens you no longer use.
 * 
 * @param tokenAddress - ERC20 token address
 * @param spender - Spender to revoke
 * @param signer - Ethers signer
 * @returns Transaction hash
 */
export async function revokeApproval(
    tokenAddress: string,
    spender: string,
    signer: Signer
): Promise<string> {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, signer);

    console.log('[Approval] Revoking approval...', {
        token: tokenAddress.slice(0, 10) + '...',
        spender: spender.slice(0, 10) + '...',
    });

    const tx = await tokenContract.approve(spender, 0);
    const receipt = await tx.wait(1);

    console.log('[Approval] Approval revoked:', receipt.transactionHash);
    return receipt.transactionHash;
}
