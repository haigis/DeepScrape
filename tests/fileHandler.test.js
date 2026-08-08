import { describe, it, expect } from 'vitest';
import { generateOutputDir, fixRelativePaths } from '../src/fileHandler.js';

describe('generateOutputDir', () => {
    it('uses ISO date folders (YYYY-MM-DD)', () => {
        const dir = generateOutputDir('https://example.com/page');
        expect(dir.replace(/\\/g, '/')).toMatch(/^output\/example\.com\/\d{4}-\d{2}-\d{2}$/);
    });

    it('falls back to output/unknown for invalid URLs', () => {
        expect(generateOutputDir('not a url')).toBe('output/unknown');
    });
});

describe('fixRelativePaths', () => {
    it('converts relative src and href to absolute URLs', () => {
        const html = '<img src="/logo.png"><a href="page/two">x</a>';
        const out = fixRelativePaths(html, 'https://example.com/dir/');
        expect(out).toContain('src="https://example.com/logo.png"');
        expect(out).toContain('href="https://example.com/dir/page/two"');
    });

    it('leaves absolute URLs untouched', () => {
        const html = '<a href="https://other.com/x">x</a>';
        expect(fixRelativePaths(html, 'https://example.com/')).toBe(html);
    });
});
