import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/accessibility.js';

describe('escapeHtml', () => {
    it('escapes markup-significant characters', () => {
        expect(escapeHtml('"><script>alert(1)</script>'))
            .toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes ampersands and quotes', () => {
        expect(escapeHtml(`a & b 'c'`)).toBe('a &amp; b &#39;c&#39;');
    });

    it('stringifies non-string input', () => {
        expect(escapeHtml(null)).toBe('null');
        expect(escapeHtml(5)).toBe('5');
    });
});
