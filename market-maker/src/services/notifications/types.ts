/**
 * Notification type definitions
 */

export enum NotificationType {
    BID_WON = 'BID_WON',
    TRANSFORM_EXECUTED = 'TRANSFORM_EXECUTED',
    LIQUIDATION_TRIGGERED = 'LIQUIDATION_TRIGGERED',
    API_ERROR = 'API_ERROR',
    TX_FAILURE = 'TX_FAILURE',
    HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED',
    BOT_STARTED = 'BOT_STARTED',
    BOT_STOPPED = 'BOT_STOPPED',
}

export type NotificationSeverity = 'info' | 'warning' | 'error' | 'success';

export interface NotificationPayload {
    type: NotificationType;
    timestamp: Date;
    severity: NotificationSeverity;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
}

export interface Notifier {
    send(payload: NotificationPayload): Promise<void>;
}
