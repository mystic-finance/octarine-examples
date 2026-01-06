/**
 * Retry utility with exponential backoff
 */

import { delay } from './delay';
import { Logger } from './logger';

export interface RetryOptions {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    retryableErrors?: (error: unknown) => boolean;
}

export const API_RETRY_DEFAULTS: RetryOptions = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableErrors: isRetryableApiError,
};

export const TX_RETRY_DEFAULTS: RetryOptions = {
    maxAttempts: 2,
    initialDelayMs: 2000,
    maxDelayMs: 5000,
    backoffMultiplier: 1.5,
    retryableErrors: isRetryableTxError,
};

export function isRetryableApiError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const err = error as { response?: { status?: number }; code?: string; message?: string };

        // Network errors
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            return true;
        }

        // HTTP status codes
        const status = err.response?.status;
        if (status) {
            // Retry on rate limit (429) and server errors (5xx)
            return status === 429 || status >= 500;
        }

        // Retry on timeout messages
        if (err.message?.toLowerCase().includes('timeout')) {
            return true;
        }
    }
    return false;
}

export function isRetryableTxError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const err = error as { message?: string; code?: string };

        // Retry on nonce errors
        if (err.message?.toLowerCase().includes('nonce')) {
            return true;
        }

        // Retry on replacement fee too low
        if (err.message?.toLowerCase().includes('replacement fee')) {
            return true;
        }

        // Retry on network errors
        if (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') {
            return true;
        }
    }
    return false;
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = API_RETRY_DEFAULTS,
    logger?: Logger,
    operationName?: string,
): Promise<T> {
    let lastError: unknown;
    let currentDelay = options.initialDelayMs;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            const isRetryable = options.retryableErrors?.(error) ?? true;
            const hasMoreAttempts = attempt < options.maxAttempts;

            if (!isRetryable || !hasMoreAttempts) {
                throw error;
            }

            logger?.warn(`${operationName || 'Operation'} failed, retrying...`, {
                attempt,
                maxAttempts: options.maxAttempts,
                nextDelayMs: currentDelay,
                error: error instanceof Error ? error.message : String(error),
            });

            await delay(currentDelay);

            // Calculate next delay with exponential backoff
            currentDelay = Math.min(
                currentDelay * options.backoffMultiplier,
                options.maxDelayMs,
            );
        }
    }

    throw lastError;
}

export class RetryExhaustedError extends Error {
    constructor(
        public originalError: unknown,
        public attempts: number,
        operationName?: string,
    ) {
        super(`${operationName || 'Operation'} failed after ${attempts} attempts`);
        this.name = 'RetryExhaustedError';
    }
}
