/**
 * Wallet manager with mutex for nonce management
 * Prevents race conditions when multiple loops use the same wallet
 */

import { ethers, Wallet } from 'ethers';
import { Mutex } from 'async-mutex';
import { Logger, createLogger } from '../../utils/logger';

export class WalletManager {
    private wallet: Wallet;
    private provider: ethers.providers.JsonRpcProvider;
    private mutex: Mutex;
    private currentNonce: number | null = null;
    private logger: Logger;

    constructor(privateKey: string, rpcUrl: string) {
        this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        this.wallet = new Wallet(privateKey, this.provider);
        this.mutex = new Mutex();
        this.logger = createLogger('wallet');
    }

    /**
     * Get the wallet for signing operations (no mutex needed for signing)
     */
    getWallet(): Wallet {
        return this.wallet;
    }

    /**
     * Get the wallet address
     */
    getAddress(): string {
        return this.wallet.address;
    }

    /**
     * Get the provider
     */
    getProvider(): ethers.providers.JsonRpcProvider {
        return this.provider;
    }

    /**
     * Get current ETH balance
     */
    async getBalance(): Promise<ethers.BigNumber> {
        return this.provider.getBalance(this.wallet.address);
    }

    /**
     * Sync nonce from the blockchain
     */
    async syncNonce(): Promise<void> {
        this.currentNonce = await this.provider.getTransactionCount(
            this.wallet.address,
            'pending',
        );
        this.logger.debug('Nonce synced', { nonce: this.currentNonce });
    }

    /**
     * Execute a transaction with nonce management
     * Uses mutex to prevent concurrent transactions from getting the same nonce
     */
    async executeTransaction<T>(
        fn: (wallet: Wallet, nonce: number) => Promise<T>,
    ): Promise<T> {
        return this.mutex.runExclusive(async () => {
            if (this.currentNonce === null) {
                await this.syncNonce();
            }

            const nonce = this.currentNonce!;
            this.logger.debug('Executing transaction', { nonce });

            try {
                const result = await fn(this.wallet, nonce);
                this.currentNonce = nonce + 1;
                return result;
            } catch (error) {
                // Reset nonce on error to resync next time
                this.currentNonce = null;
                throw error;
            }
        });
    }

    /**
     * Send a transaction with automatic nonce management
     */
    async sendTransaction(
        tx: ethers.providers.TransactionRequest,
    ): Promise<ethers.providers.TransactionResponse> {
        return this.executeTransaction(async (wallet, nonce) => {
            const txWithNonce = { ...tx, nonce };
            return wallet.sendTransaction(txWithNonce);
        });
    }

    /**
     * Wait for a transaction to be confirmed
     */
    async waitForTransaction(
        txHash: string,
        confirmations: number = 1,
        timeout: number = 60000,
    ): Promise<ethers.providers.TransactionReceipt> {
        const receipt = await Promise.race([
            this.provider.waitForTransaction(txHash, confirmations),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Transaction confirmation timeout')), timeout),
            ),
        ]);

        if (receipt.status === 0) {
            throw new Error(`Transaction failed: ${txHash}`);
        }

        return receipt;
    }
}

// Singleton instance
let walletManagerInstance: WalletManager | null = null;

export function initWalletManager(privateKey: string, rpcUrl: string): WalletManager {
    walletManagerInstance = new WalletManager(privateKey, rpcUrl);
    return walletManagerInstance;
}

export function getWalletManager(): WalletManager {
    if (!walletManagerInstance) {
        throw new Error('WalletManager not initialized. Call initWalletManager first.');
    }
    return walletManagerInstance;
}
