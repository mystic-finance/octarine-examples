/**
 * Delay/sleep utility
 */

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function delayWithJitter(ms: number, jitterPercent: number = 0.1): Promise<void> {
    const jitter = ms * jitterPercent * (Math.random() - 0.5) * 2;
    return delay(Math.max(0, ms + jitter));
}
