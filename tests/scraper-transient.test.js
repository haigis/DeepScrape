import { describe, it, expect } from 'vitest';
import { isTransientError } from '../src/scraper.js';

describe('isTransientError', () => {
    it('recognises browser and network failures worth retrying', () => {
        for (const message of [
            'Timed out after waiting 30000ms',
            'browser did not open a tab within 20000ms',
            'Protocol error (Page.navigate): Target closed',
            'Navigation timeout of 30000 ms exceeded',
            'net::ERR_CONNECTION_RESET at https://x.example/',
            'read ECONNRESET',
            'socket hang up',
        ]) expect(isTransientError(message), message).toBe(true);
    });

    it('treats page-level failures as final', () => {
        for (const message of [
            'HTTP 404',
            'net::ERR_NAME_NOT_RESOLVED at https://x.example/',
            'page deadline exceeded (120000ms)',
            'cancelled',
            'non-HTML content-type: application/pdf',
            '',
            undefined,
        ]) expect(isTransientError(message), String(message)).toBe(false);
    });
});
