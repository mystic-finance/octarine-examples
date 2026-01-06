/**
 * WebSocket service for real-time API events
 * Provides an alternative to polling for RFQ requests and liquidation opportunities
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { RFQRequest, Liquidation } from '../../types';
import { createLogger } from '../../utils/logger';
import { delay } from '../../utils/delay';

const logger = createLogger('websocket');

export type WebSocketEvent =
    | { type: 'rfq_request'; data: RFQRequest }
    | { type: 'liquidation'; data: Liquidation }
    | { type: 'bid_accepted'; data: { requestId: string; bidId: string } }
    | { type: 'connected' }
    | { type: 'disconnected'; reason: string }
    | { type: 'error'; error: Error };

export interface WebSocketConfig {
    url: string;
    reconnectIntervalMs: number;
    supportedChains: number[];
    marketMakerAddress: string;
}

export class OctarineWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: WebSocketConfig;
    private isConnected = false;
    private shouldReconnect = true;
    private reconnectTimeout: NodeJS.Timeout | null = null;

    constructor(config: WebSocketConfig) {
        super();
        this.config = config;
    }

    /**
     * Connect to the WebSocket server
     */
    async connect(): Promise<void> {
        if (this.ws) {
            logger.warn('WebSocket already connected');
            return;
        }

        this.shouldReconnect = true;

        return new Promise((resolve, reject) => {
            try {
                logger.info('Connecting to WebSocket', { url: this.config.url });

                this.ws = new WebSocket(this.config.url);

                this.ws.on('open', () => {
                    this.isConnected = true;
                    logger.info('WebSocket connected');

                    // Subscribe to events for supported chains
                    this.subscribe();

                    this.emit('event', { type: 'connected' } as WebSocketEvent);
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', (code, reason) => {
                    this.isConnected = false;
                    const reasonStr = reason?.toString() || `Code: ${code}`;
                    logger.warn('WebSocket disconnected', { code, reason: reasonStr });

                    this.emit('event', { type: 'disconnected', reason: reasonStr } as WebSocketEvent);

                    if (this.shouldReconnect) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (error) => {
                    logger.error('WebSocket error', error);
                    this.emit('event', { type: 'error', error } as WebSocketEvent);

                    if (!this.isConnected) {
                        reject(error);
                    }
                });
            } catch (error) {
                logger.error('Failed to create WebSocket', error instanceof Error ? error : new Error(String(error)));
                reject(error);
            }
        });
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        this.shouldReconnect = false;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.isConnected = false;
        logger.info('WebSocket disconnected intentionally');
    }

    /**
     * Check if connected
     */
    getIsConnected(): boolean {
        return this.isConnected;
    }

    /**
     * Subscribe to events for supported chains
     */
    private subscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const subscribeMessage = {
            action: 'subscribe',
            channels: ['rfq_requests', 'liquidations', 'bids'],
            filters: {
                chains: this.config.supportedChains,
                marketMaker: this.config.marketMakerAddress,
            },
        };

        this.ws.send(JSON.stringify(subscribeMessage));
        logger.debug('Subscribed to channels', {
            channels: subscribeMessage.channels,
            chains: this.config.supportedChains,
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const message = JSON.parse(data.toString());

            logger.debug('WebSocket message received', { type: message.type });

            switch (message.type) {
                case 'rfq_request':
                    // Filter by supported chains
                    if (this.config.supportedChains.includes(message.data.chainId)) {
                        this.emit('event', {
                            type: 'rfq_request',
                            data: message.data as RFQRequest,
                        } as WebSocketEvent);
                    }
                    break;

                case 'liquidation':
                    if (this.config.supportedChains.includes(message.data.chainId)) {
                        this.emit('event', {
                            type: 'liquidation',
                            data: message.data as Liquidation,
                        } as WebSocketEvent);
                    }
                    break;

                case 'bid_accepted':
                    this.emit('event', {
                        type: 'bid_accepted',
                        data: message.data,
                    } as WebSocketEvent);
                    break;

                case 'pong':
                    // Heartbeat response, ignore
                    break;

                default:
                    logger.debug('Unknown message type', { type: message.type });
            }
        } catch (error) {
            logger.warn('Failed to parse WebSocket message', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Schedule reconnection after disconnect
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            return;
        }

        logger.info('Scheduling reconnect', {
            delayMs: this.config.reconnectIntervalMs,
        });

        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            this.ws = null;

            try {
                await this.connect();
            } catch (error) {
                logger.error('Reconnection failed', error instanceof Error ? error : new Error(String(error)));
                // Will retry on next disconnect event
            }
        }, this.config.reconnectIntervalMs);
    }

    /**
     * Send a ping to keep the connection alive
     */
    ping(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }
}

// Singleton instance
let wsInstance: OctarineWebSocket | null = null;

export function initWebSocket(config: WebSocketConfig): OctarineWebSocket {
    wsInstance = new OctarineWebSocket(config);
    return wsInstance;
}

export function getWebSocket(): OctarineWebSocket | null {
    return wsInstance;
}
