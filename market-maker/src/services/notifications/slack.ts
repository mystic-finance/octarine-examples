/**
 * Slack notification implementation using @slack/webhook
 */

import { IncomingWebhook, IncomingWebhookResult } from '@slack/webhook';
import { NotificationPayload, NotificationSeverity, NotificationType, Notifier } from './types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('slack');

const SEVERITY_COLORS: Record<NotificationSeverity, string> = {
    info: '#2196F3',     // Blue
    warning: '#FF9800',  // Orange
    error: '#F44336',    // Red
    success: '#4CAF50',  // Green
};

const TYPE_EMOJI: Record<NotificationType, string> = {
    [NotificationType.BID_WON]: ':trophy:',
    [NotificationType.TRANSFORM_EXECUTED]: ':white_check_mark:',
    [NotificationType.LIQUIDATION_TRIGGERED]: ':moneybag:',
    [NotificationType.API_ERROR]: ':x:',
    [NotificationType.TX_FAILURE]: ':warning:',
    [NotificationType.HEALTH_CHECK_FAILED]: ':rotating_light:',
    [NotificationType.BOT_STARTED]: ':rocket:',
    [NotificationType.BOT_STOPPED]: ':stop_sign:',
};

export class SlackNotifier implements Notifier {
    private webhook: IncomingWebhook;

    constructor(webhookUrl: string) {
        this.webhook = new IncomingWebhook(webhookUrl);
    }

    async send(payload: NotificationPayload): Promise<void> {
        const emoji = TYPE_EMOJI[payload.type] || ':bell:';
        const color = SEVERITY_COLORS[payload.severity];

        const fields = payload.metadata
            ? Object.entries(payload.metadata).map(([key, value]) => ({
                title: this.formatFieldTitle(key),
                value: this.formatFieldValue(value),
                short: true,
            }))
            : [];

        try {
            await this.webhook.send({
                text: `${emoji} ${payload.title}`,
                attachments: [
                    {
                        color,
                        text: payload.message,
                        fields,
                        footer: 'Octarine Market Maker Bot',
                        ts: Math.floor(payload.timestamp.getTime() / 1000).toString(),
                    },
                ],
            });

            logger.debug('Slack notification sent', {
                type: payload.type,
                title: payload.title,
            });
        } catch (error) {
            logger.error('Failed to send Slack notification', error instanceof Error ? error : new Error(String(error)), {
                type: payload.type,
            });
            // Don't throw - notifications should not break the main flow
        }
    }

    private formatFieldTitle(key: string): string {
        return key
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .trim();
    }

    private formatFieldValue(value: unknown): string {
        if (value === null || value === undefined) {
            return 'N/A';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    }
}
