/**
 * Web3/Ethers.js Utilities for Octarine User App
 * 
 * This module provides blockchain interaction utilities for the user-facing
 * swap application. It handles token approvals and wallet connections.
 * 
 * ## Key Concepts:
 * 
 * - **Token Approvals**: ERC20 tokens require explicit approval before spending
 * - **Infinite Approvals**: Common UX pattern to approve max uint256 once
 * - **Allowance Checking**: Prevents unnecessary approval transactions
 * 
 * @module Web3Service
 */

import { ethers } from 'ethers';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Result of an approval transaction.
 */
export interface ApprovalResult {
    /** Transaction hash if approval was submitted */
    txHash: string | null;
    /** Whether approval was already sufficient */
    alreadyApproved: boolean;
    /** Token symbol (if fetched) */
    symbol?: string;
}

/**
 * Token information from contract.
 */
export interface TokenInfo {
    symbol: string;
    decimals: number;
    name: string;
}

// ============================================================================
// ERC20 ABI
// ============================================================================

/**
 * Minimal ERC20 ABI for approval operations.
 */
const ERC20_ABI = [
    /**
     * @notice Approve spender to transfer tokens
     * @param spender Address authorized to spend
     * @param amount Maximum amount (use MaxUint256 for unlimited)
     */
    'function approve(address spender, uint256 amount) external returns (bool)',
    
    /**
     * @notice Check remaining allowance
     * @param owner Token owner
     * @param spender Authorized spender
     * @return remaining Amount still allowed
     */
    'function allowance(address owner, address spender) view returns (uint256)',
    
    /**
     * @notice Get token symbol
     */
    'function symbol() view returns (string)',
    
    /**
     * @notice Get token decimals
     */
    'function decimals() view returns (uint8)',
    
    /**
     * @notice Get token name
     */
    'function name() view returns (string)',
    
    /**
     * @notice Get token balance
     */
    'function balanceOf(address account) view returns (uint256)',
];

// ============================================================================
// TOKEN APPROVAL FUNCTIONS
// ============================================================================

/**
 * Approve a spender contract to transfer tokens on behalf of the user.
 * 
 * This implements the "infinite approval" pattern common in DeFi:
 * - Approve max uint256 once
 * - Avoids needing approvals for future transactions
 * - More gas-efficient for repeated use
 * 
 * For security-conscious users, custom approval amounts can be used instead.
 * 
 * @param spender - Contract address to approve (Octarine Exchange Proxy)
 * @param amount - Amount needed (for checking existing allowance)
 * @param tokenAddress - ERC20 token contract address
 * @param signer - Ethers signer instance
 * @returns Approval result with transaction details
 * 
 * @example
 * ```typescript
 * const result = await approveToken(
 *   '0xExchangeProxy...',
 *   '1000000000000000000',
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
    signer: ethers.Signer
): Promise<ApprovalResult> {
    const owner = await signer.getAddress();

    console.log('[Web3] Checking token approval:', {
        token: tokenAddress.slice(0, 10) + '...',
        spender: spender.slice(0, 10) + '...',
        owner: owner.slice(0, 10) + '...',
    });

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    // Check current allowance
    const currentAllowance: ethers.BigNumber = await tokenContract.allowance(
        owner,
        spender
    );

    const requiredAmount = ethers.BigNumber.from(amount);

    // If current allowance is sufficient, skip approval
    // Using 5x buffer for future transactions
    const bufferMultiplier = 5;
    const requiredWithBuffer = requiredAmount.mul(bufferMultiplier);

    if (currentAllowance.gt(requiredWithBuffer)) {
        console.log('[Web3] Token already approved (sufficient allowance)');
        return { txHash: null, alreadyApproved: true };
    }

    // Get token symbol for logging
    let symbol: string;
    try {
        symbol = await tokenContract.symbol();
    } catch {
        symbol = 'UNKNOWN';
    }

    console.log(`[Web3] Approving ${symbol}...`);

    // Submit approval with max uint256 (infinite approval pattern)
    const tx = await tokenContract.approve(spender, ethers.constants.MaxUint256);
    
    console.log(`[Web3] Approval transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    
    console.log(`[Web3] Approval confirmed: ${receipt.transactionHash}`);

    return {
        txHash: receipt.transactionHash,
        alreadyApproved: false,
        symbol,
    };
}

/**
 * Check if a token approval exists without submitting a transaction.
 * 
 * Useful for UI state (showing "Approve" vs "Swap" buttons).
 * 
 * @param tokenAddress - ERC20 token address
 * @param owner - Token owner address
 * @param spender - Spender to check
 * @param provider - Ethers provider
 * @param requiredAmount - Minimum required allowance
 * @returns true if approval exists and is sufficient
 */
export async function checkTokenApproval(
    tokenAddress: string,
    owner: string,
    spender: string,
    provider: ethers.providers.Provider,
    requiredAmount: string
): Promise<boolean> {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const allowance: ethers.BigNumber = await tokenContract.allowance(
            owner,
            spender
        );
        const required = ethers.BigNumber.from(requiredAmount);
        
        return allowance.gte(required);
    } catch (error) {
        console.error('[Web3] Failed to check approval:', error);
        return false;
    }
}

/**
 * Approve a specific amount instead of infinite approval.
 * 
 * Use this for security-conscious flows where users want to
 * approve only the exact amount needed.
 * 
 * @param spender - Contract to approve
 * @param exactAmount - Exact amount to approve
 * @param tokenAddress - Token contract address
 * @param signer - Ethers signer
 */
export async function approveExactAmount(
    spender: string,
    exactAmount: string,
    tokenAddress: string,
    signer: ethers.Signer
): Promise<ApprovalResult> {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    let symbol: string;
    try {
        symbol = await tokenContract.symbol();
    } catch {
        symbol = 'UNKNOWN';
    }

    console.log(`[Web3] Approving exact ${exactAmount} ${symbol}...`);

    const tx = await tokenContract.approve(spender, exactAmount);
    const receipt = await tx.wait();

    return {
        txHash: receipt.transactionHash,
        alreadyApproved: false,
        symbol,
    };
}

// ============================================================================
// TOKEN INFO FUNCTIONS
// ============================================================================

/**
 * Fetch token metadata from contract.
 * 
 * @param tokenAddress - ERC20 token address
 * @param provider - Ethers provider
 * @returns Token info or null if call fails
 */
export async function getTokenInfo(
    tokenAddress: string,
    provider: ethers.providers.Provider
): Promise<TokenInfo | null> {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        
        const [symbol, decimals, name] = await Promise.all([
            tokenContract.symbol().catch(() => 'UNKNOWN'),
            tokenContract.decimals().catch(() => 18),
            tokenContract.name().catch(() => 'Unknown Token'),
        ]);

        return { symbol, decimals, name };
    } catch (error) {
        console.error('[Web3] Failed to fetch token info:', error);
        return null;
    }
}

/**
 * Format token amount for display.
 * 
 * @param amountWei - Amount in wei
 * @param decimals - Token decimals (default: 18)
 * @returns Formatted string (e.g., "1,234.567")
 */
export function formatTokenAmount(
    amountWei: string,
    decimals: number = 18
): string {
    try {
        const formatted = ethers.utils.formatUnits(amountWei, decimals);
        
        // Format with commas and reasonable precision
        const number = parseFloat(formatted);
        if (number === 0) return '0';
        
        // Use 6 decimal places for small numbers, fewer for large
        const precision = number < 1 ? 6 : number < 1000 ? 4 : 2;
        return number.toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: precision,
        });
    } catch {
        return amountWei;
    }
}

/**
 * Parse user input to wei string.
 * 
 * @param amount - User input (e.g., "1.5")
 * @param decimals - Token decimals
 * @returns Amount in wei as string
 */
export function parseTokenAmount(
    amount: string,
    decimals: number = 18
): string {
    try {
        return ethers.utils.parseUnits(amount, decimals).toString();
    } catch {
        return '0';
    }
}

// ============================================================================
// WALLET CONNECTION
// ============================================================================

/**
 * Request wallet connection and return provider/signer.
 * 
 * @returns Object with provider, signer, and connected address
 * @throws Error if wallet not installed or user rejects
 */
export async function connectWallet(): Promise<{
    provider: ethers.providers.Web3Provider;
    signer: ethers.Signer;
    address: string;
}> {
    if (!window.ethereum) {
        throw new Error('No Ethereum wallet detected. Please install MetaMask.');
    }

    const provider = new ethers.providers.Web3Provider(window.ethereum);
    
    // Request account access
    const accounts = await provider.send('eth_requestAccounts', []);
    
    if (!accounts || accounts.length === 0) {
        throw new Error('No accounts available. Please unlock your wallet.');
    }

    const signer = provider.getSigner();
    const address = await signer.getAddress();

    return { provider, signer, address };
}

/**
 * Get current chain ID from wallet.
 * 
 * @param provider - Ethers provider
 * @returns Chain ID number
 */
export async function getChainId(
    provider: ethers.providers.Provider
): Promise<number> {
    const network = await provider.getNetwork();
    return network.chainId;
}

/**
 * Check if connected to correct network.
 * 
 * @param provider - Ethers provider
 * @param expectedChainId - Expected chain ID
 * @returns true if on correct network
 */
export async function isCorrectNetwork(
    provider: ethers.providers.Provider,
    expectedChainId: number
): Promise<boolean> {
    const chainId = await getChainId(provider);
    return chainId === expectedChainId;
}

// Extend Window interface for Ethereum
declare global {
    interface Window {
        ethereum?: any;
    }
}
