/**
 * Notification service facade
 * Manages notification queue and dispatches to configured notifiers
 */

import { NotificationPayload, NotificationType, Notifier } from './types';
import { SlackNotifier } from './slack';
import { AppConfig } from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('notifications');

export class NotificationService {
    private notifiers: Notifier[] = [];
    private queue: NotificationPayload[] = [];
    private isProcessing = false;
    private enabled = false;

    constructor(config: AppConfig) {
        if (config.slackEnabled && config.slackWebhookUrl) {
            this.notifiers.push(new SlackNotifier(config.slackWebhookUrl));
            this.enabled = true;
            logger.info('Slack notifications enabled');
        }

        if (!this.enabled) {
            logger.info('Notifications disabled');
        }
    }

    /**
     * Queue a notification for delivery
     * Non-blocking - returns immediately
     */
    notify(payload: NotificationPayload): void {
        if (!this.enabled) {
            return;
        }

        this.queue.push(payload);
        this.processQueue();
    }

    /**
     * Process the notification queue
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const payload = this.queue.shift()!;

            for (const notifier of this.notifiers) {
                try {
                    await notifier.send(payload);
                } catch (error) {
                    logger.error('Failed to send notification', error instanceof Error ? error : new Error(String(error)));
                }
            }
        }

        this.isProcessing = false;
    }

    // =========================================================================
    // Convenience methods for common notifications
    // =========================================================================

    notifyBotStarted(): void {
        this.notify({
            type: NotificationType.BOT_STARTED,
            timestamp: new Date(),
            severity: 'info',
            title: 'Market Maker Bot Started',
            message: 'The bot has started and is now monitoring for opportunities.',
        });
    }

    notifyBotStopped(reason?: string): void {
        this.notify({
            type: NotificationType.BOT_STOPPED,
            timestamp: new Date(),
            severity: 'warning',
            title: 'Market Maker Bot Stopped',
            message: reason || 'The bot has stopped.',
        });
    }

    notifyBidWon(requestId: string, makerAmount: string, chainId?: number): void {
        this.notify({
            type: NotificationType.BID_WON,
            timestamp: new Date(),
            severity: 'success',
            title: 'Bid Won!',
            message: `Your bid on request ${requestId} was accepted.`,
            metadata: {
                requestId,
                makerAmount,
                chainId,
            },
        });
    }

    notifyTransformExecuted(requestId: string, txHash?: string): void {
        this.notify({
            type: NotificationType.TRANSFORM_EXECUTED,
            timestamp: new Date(),
            severity: 'success',
            title: 'Transform Executed',
            message: `Successfully executed transform for request ${requestId}.`,
            metadata: {
                requestId,
                txHash,
            },
        });
    }

    notifyLiquidationTriggered(liquidationId: string, txHash: string, profit?: string): void {
        this.notify({
            type: NotificationType.LIQUIDATION_TRIGGERED,
            timestamp: new Date(),
            severity: 'success',
            title: 'Liquidation Triggered',
            message: `Successfully triggered liquidation ${liquidationId}.`,
            metadata: {
                liquidationId,
                txHash,
                estimatedProfit: profit,
            },
        });
    }

    notifyApiError(operation: string, error: Error, context?: Record<string, unknown>): void {
        this.notify({
            type: NotificationType.API_ERROR,
            timestamp: new Date(),
            severity: 'error',
            title: 'API Error',
            message: `${operation} failed: ${error.message}`,
            metadata: {
                operation,
                error: error.message,
                ...context,
            },
        });
    }

    notifyTxFailure(operation: string, error: Error, txHash?: string): void {
        this.notify({
            type: NotificationType.TX_FAILURE,
            timestamp: new Date(),
            severity: 'error',
            title: 'Transaction Failed',
            message: `${operation} transaction failed: ${error.message}`,
            metadata: {
                operation,
                txHash,
                error: error.message,
            },
        });
    }

    notifyHealthCheckFailed(checkName: string, details: string): void {
        this.notify({
            type: NotificationType.HEALTH_CHECK_FAILED,
            timestamp: new Date(),
            severity: 'error',
            title: 'Health Check Failed',
            message: `${checkName}: ${details}`,
            metadata: {
                check: checkName,
                details,
            },
        });
    }
}

// Singleton instance
let notificationServiceInstance: NotificationService | null = null;

export function initNotificationService(config: AppConfig): NotificationService {
    notificationServiceInstance = new NotificationService(config);
    return notificationServiceInstance;
}

export function getNotificationService(): NotificationService {
    if (!notificationServiceInstance) {
        throw new Error('NotificationService not initialized. Call initNotificationService first.');
    }
    return notificationServiceInstance;
}

// Re-export types
export * from './types';
