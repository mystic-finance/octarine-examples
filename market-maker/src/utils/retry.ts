/**
 * Retry Utility with Exponential Backoff
 * 
 * Provides resilient network operations with configurable retry strategies.
 * Essential for blockchain interactions where transient failures are common.
 */

import { logger, LogContext } from './logger';

export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial delay in milliseconds (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay in milliseconds (default: 30000) */
    maxDelayMs?: number;
    /** Backoff multiplier (default: 2) */
    backoffMultiplier?: number;
    /** Whether to add random jitter to prevent thundering herd (default: true) */
    jitter?: boolean;
    /** Optional callback for each retry attempt */
    onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
    /** Context for logging */
    context?: LogContext;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitter: true,
    onRetry: () => {},
    context: {},
};

/**
 * Calculate delay with exponential backoff and optional jitter
 */
function calculateDelay(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    backoffMultiplier: number,
    jitter: boolean
): number {
    // Exponential backoff: initial * (multiplier ^ attempt)
    let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
    delay = Math.min(delay, maxDelayMs);

    if (jitter) {
        // Add ±25% random jitter to prevent synchronized retries
        const jitterFactor = 0.75 + Math.random() * 0.5;
        delay = Math.floor(delay * jitterFactor);
    }

    return delay;
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * 
 * @example
 * ```typescript
 * const result = await retry(async () => {
 *   return await fetchDataFromAPI();
 * }, { maxRetries: 5, context: { operation: 'fetchData' } });
 * ```
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            const result = await fn();
            
            if (attempt > 0) {
                logger.info(`Operation succeeded after ${attempt} retry(s)`, opts.context);
            }
            
            return result;
        } catch (error: any) {
            lastError = error;
            
            if (attempt < opts.maxRetries) {
                const nextDelayMs = calculateDelay(
                    attempt,
                    opts.initialDelayMs,
                    opts.maxDelayMs,
                    opts.backoffMultiplier,
                    opts.jitter
                );

                logger.warn(
                    `Attempt ${attempt + 1} failed, retrying in ${nextDelayMs}ms`,
                    { ...opts.context, attempt: attempt + 1, nextDelayMs }
                );

                if (opts.onRetry) {
                    opts.onRetry(attempt + 1, error, nextDelayMs);
                }

                await sleep(nextDelayMs);
            }
        }
    }

    // All retries exhausted
    logger.error(
        `Operation failed after ${opts.maxRetries + 1} attempts`,
        opts.context,
        lastError!
    );
    
    throw lastError;
}

/**
 * Conditional retry - only retries on specific error types
 * 
 * @example
 * ```typescript
 * const result = await retryIf(
 *   async () => await apiCall(),
 *   (error) => error.code === 'NETWORK_ERROR', // Only retry on network errors
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function retryIf<T>(
    fn: () => Promise<T>,
    shouldRetry: (error: any) => boolean,
    options: RetryOptions = {}
): Promise<T> {
    const wrappedFn = async (): Promise<T> => {
        try {
            return await fn();
        } catch (error: any) {
            if (!shouldRetry(error)) {
                // Don't retry - immediately throw
                throw new RetryAbortedError('Retry condition not met', error);
            }
            throw error;
        }
    };

    return retry(wrappedFn, options);
}

/**
 * Error thrown when retry is aborted due to condition not met
 */
export class RetryAbortedError extends Error {
    constructor(
        message: string,
        public readonly originalError: any
    ) {
        super(message);
        this.name = 'RetryAbortedError';
    }
}

/**
 * Circuit breaker pattern - stop retrying after repeated failures
 * Useful for protecting downstream services from overload
 */
export class CircuitBreaker {
    private failures = 0;
    private lastFailureTime: number | null = null;
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

    constructor(
        private readonly failureThreshold = 5,
        private readonly resetTimeoutMs = 30000
    ) {}

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === 'OPEN') {
            const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
            
            if (timeSinceLastFailure < this.resetTimeoutMs) {
                throw new Error('Circuit breaker is OPEN - too many failures');
            }
            
            // Transition to half-open to test if service recovered
            this.state = 'HALF_OPEN';
            logger.info('Circuit breaker entering HALF_OPEN state');
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    private onSuccess(): void {
        this.failures = 0;
        
        if (this.state === 'HALF_OPEN') {
            this.state = 'CLOSED';
            logger.info('Circuit breaker closed - service recovered');
        }
    }

    private onFailure(): void {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
            logger.error(`Circuit breaker OPENED after ${this.failures} failures`);
        }
    }

    getState(): string {
        return this.state;
    }
}
