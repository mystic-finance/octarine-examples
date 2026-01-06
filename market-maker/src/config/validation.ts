/**
 * Configuration validation utilities
 */

import { LogLevel } from '../types';

export class ConfigValidationError extends Error {
    constructor(public errors: string[]) {
        super(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
        this.name = 'ConfigValidationError';
    }
}

export function parseChains(value: string | undefined): number[] {
    if (!value || value.trim() === '') {
        return [];
    }

    return value.split(',').map(c => {
        const trimmed = c.trim();
        const parsed = parseInt(trimmed, 10);
        return parsed;
    });
}

export function parseTokens(value: string | undefined): string[] {
    if (!value || value.trim() === '') {
        return ['*'];
    }

    return value.split(',').map(t => t.trim()).filter(t => t.length > 0);
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined || value === '') {
        return defaultValue;
    }
    return value.toLowerCase() === 'true' || value === '1';
}

export function parseNumber(value: string | undefined, defaultValue: number): number {
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
}

export function parseInt_(value: string | undefined, defaultValue: number): number {
    if (value === undefined || value === '') {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

export function parseLogLevel(value: string | undefined): LogLevel {
    const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (value && valid.includes(value as LogLevel)) {
        return value as LogLevel;
    }
    return 'info';
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export function validateRequired(value: string | undefined, name: string): string | null {
    if (!value || value.trim() === '') {
        return `${name} is required`;
    }
    return null;
}

export function validateChains(chains: number[]): string | null {
    if (chains.length === 0) {
        return 'SUPPORTED_CHAINS must have at least one valid chain ID';
    }

    const invalidChains = chains.filter(c => isNaN(c) || c <= 0);
    if (invalidChains.length > 0) {
        return `SUPPORTED_CHAINS contains invalid chain IDs: ${invalidChains.join(', ')}`;
    }

    return null;
}

export function validateSpread(spread: number, name: string): string | null {
    if (isNaN(spread) || spread <= 0 || spread > 1) {
        return `${name} must be between 0 and 1 (e.g., 0.98 for 2% spread)`;
    }
    return null;
}

export function validateAddress(value: string | undefined, name: string): string | null {
    if (!value) {
        return `${name} is required`;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        return `${name} must be a valid Ethereum address`;
    }
    return null;
}

export function validatePrivateKey(value: string | undefined): string | null {
    if (!value) {
        return 'PRIVATE_KEY is required';
    }
    // Remove 0x prefix if present for length check
    const key = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[a-fA-F0-9]{64}$/.test(key)) {
        return 'PRIVATE_KEY must be a valid 32-byte hex string';
    }
    return null;
}

export function validateUrl(value: string | undefined, name: string, required: boolean = true): string | null {
    if (!value || value.trim() === '') {
        return required ? `${name} is required` : null;
    }
    try {
        new URL(value);
        return null;
    } catch {
        return `${name} must be a valid URL`;
    }
}
