/**
 * Structured Logging Utility for Octarine Market Maker
 * 
 * This module provides consistent, configurable logging across the bot.
 * Production deployments should integrate with their preferred logging service
 * (Datadog, Splunk, CloudWatch, etc.)
 */

export enum LogLevel {
    SILENT = 0,
    ERROR = 1,
    WARN = 2,
    INFO = 3,
    DEBUG = 4,
    TRACE = 5,
}

export interface LogContext {
    requestId?: string;
    liquidationId?: string;
    bidId?: string;
    operation?: string;
    [key: string]: any;
}

class Logger {
    private level: LogLevel;

    constructor(level: LogLevel = LogLevel.INFO) {
        this.level = level;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    private formatMessage(
        level: string,
        message: string,
        context?: LogContext,
        error?: Error
    ): string {
        const timestamp = new Date().toISOString();
        const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
        const errorStr = error ? ` | error: ${error.message}` : '';
        return `[${timestamp}] [${level}] ${message}${contextStr}${errorStr}`;
    }

    error(message: string, context?: LogContext, error?: Error): void {
        if (this.level >= LogLevel.ERROR) {
            console.error(this.formatMessage('ERROR', message, context, error));
        }
    }

    warn(message: string, context?: LogContext): void {
        if (this.level >= LogLevel.WARN) {
            console.warn(this.formatMessage('WARN', message, context));
        }
    }

    info(message: string, context?: LogContext): void {
        if (this.level >= LogLevel.INFO) {
            console.info(this.formatMessage('INFO', message, context));
        }
    }

    debug(message: string, context?: LogContext): void {
        if (this.level >= LogLevel.DEBUG) {
            console.log(this.formatMessage('DEBUG', message, context));
        }
    }

    trace(message: string, context?: LogContext): void {
        if (this.level >= LogLevel.TRACE) {
            console.log(this.formatMessage('TRACE', message, context));
        }
    }

    /**
     * Log a successful operation with timing information
     */
    success(operation: string, durationMs: number, context?: LogContext): void {
        this.info(`${operation} completed successfully`, {
            ...context,
            operation,
            durationMs,
            status: 'success',
        });
    }

    /**
     * Log metrics for monitoring dashboards
     */
    metric(name: string, value: number, unit: string, context?: LogContext): void {
        this.info(`METRIC: ${name}`, {
            ...context,
            metricName: name,
            metricValue: value,
            metricUnit: unit,
        });
    }
}

// Global logger instance
export const logger = new Logger(
    process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : LogLevel.INFO
);

export default logger;
