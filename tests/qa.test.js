import { describe, it, expect } from 'vitest';
import { extractQa, extractChunks, questionKey } from '../src/qa.js';

const FAQ_JSONLD = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
        { '@type': 'Question', name: 'How long is delivery?', acceptedAnswer: { '@type': 'Answer', text: 'Delivery takes 3-5 working days across the UK.' } },
        { '@type': 'Question', name: 'What is the return policy?', acceptedAnswer: { '@type': 'Answer', text: '<p>Returns are free within 30 days of purchase.</p>' } },
    ],
})}</script>`;

describe('extractQa', () => {
    it('reads FAQPage JSON-LD first and strips answer markup', () => {
        const pairs = extractQa(`<html><head>${FAQ_JSONLD}</head><body></body></html>`);
        expect(pairs).toHaveLength(2);
        expect(pairs[0]).toMatchObject({ extractor: 'jsonld', question: 'How long is delivery?' });
        expect(pairs[1].answer).toBe('Returns are free within 30 days of purchase.');
    });

    it('reads details/summary accordions', () => {
        const pairs = extractQa(`<html><body>
            <details><summary>Can I change my order?</summary><p>Yes — within one hour of placing it, from your account page.</p></details>
        </body></html>`);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].extractor).toBe('details');
        expect(pairs[0].answer).toContain('within one hour');
    });

    it('reads question-shaped dt/dd and headings, skipping non-questions', () => {
        const pairs = extractQa(`<html><body>
            <dl><dt>Do you ship internationally?</dt><dd>We ship to the EU and the US; other regions on request.</dd>
                <dt>Head office</dt><dd>12 High Street, Glasgow — this is not a question so it is skipped.</dd></dl>
            <h2>How do refunds work?</h2><p>Refunds land within 5 working days of us receiving the item.</p>
            <h2>Our story</h2><p>Founded in 2019 — not a question, skipped.</p>
        </body></html>`);
        expect(pairs.map(p => p.extractor).sort()).toEqual(['dl', 'heading']);
        expect(pairs.find(p => p.extractor === 'dl').question).toBe('Do you ship internationally?');
    });

    it('reads custom selector pairs inside containers', () => {
        const pairs = extractQa(`<html><body>
            <div class="faq-tile"><span class="q">Is there a warranty?</span><div class="a">Every device carries a two-year warranty from delivery.</div></div>
            <div class="faq-tile"><span class="q">Where are you based?</span><div class="a">We operate from Glasgow with a warehouse in Leeds.</div></div>
        </body></html>`, [{ container: '.faq-tile', question: '.q', answer: '.a' }]);
        expect(pairs).toHaveLength(2);
        expect(pairs.every(p => p.extractor === 'selector')).toBe(true);
    });

    it('dedupes the same question across extractors, JSON-LD winning', () => {
        const pairs = extractQa(`<html><head>${FAQ_JSONLD}</head><body>
            <h2>How long is delivery?</h2><p>A different, scraped answer that should lose to JSON-LD.</p>
        </body></html>`);
        const delivery = pairs.filter(p => questionKey(p.question) === questionKey('How long is delivery?'));
        expect(delivery).toHaveLength(1);
        expect(delivery[0].extractor).toBe('jsonld');
    });
});

describe('extractChunks', () => {
    it('produces heading-scoped chunks and skips chrome', () => {
        const chunks = extractChunks(`<html><body>
            <nav>Home About Contact — chrome that must not leak</nav>
            <main>
              <h2>Delivery</h2><p>Orders placed before 2pm ship the same day from our Glasgow warehouse.</p>
              <h2>Warranty</h2><p>Every device carries a two-year warranty covering parts and labour.</p>
            </main>
            <footer>© 2026 — also chrome</footer>
        </body></html>`);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].heading).toBe('Delivery');
        expect(chunks.some(c => c.text.includes('chrome'))).toBe(false);
    });

    it('falls back to one body chunk when there are no headings', () => {
        const chunks = extractChunks('<html><body><main><p>A single block of copy long enough to count as a chunk on its own.</p></main></body></html>');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].heading).toBeNull();
    });
});
