/**
 * Extractability & answer-readiness signals (rating v3, issue #38).
 *
 * How easily can a correct answer be *lifted* from a page, given that
 * AI retrieval pipelines chunk pages by headings and embed sections
 * independently? Heuristics here are deliberately conservative and
 * carry reduced confidence — a false "hard to extract" is worse than a
 * missed one.
 */

const innerText = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Question-shaped heading: starts with an interrogative or ends with ?. */
const QUESTION_RE = /^(how|what|why|when|where|who|which|can|do|does|is|are|should)\b|\?\s*$/i;

/** Fact-shaped content: phone, price or postcode patterns. */
const FACT_RE = /(?:\+44\s?|\b0)\d[\d\s-]{8,12}\d|[£$€]\s?\d[\d,]*(?:\.\d{2})?|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/;

/**
 * Per-page extractability profile from saved HTML.
 * @param {string} html
 */
export function analyzePageExtractability(html) {
    const hasMain = /<(main|article)[\s>]/i.test(html);

    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
        .map(m => innerText(m[1]))
        .filter(Boolean);
    const questionHeadings = headings.filter(h => QUESTION_RE.test(h)).length;

    const hasTable = /<table[\s>]/i.test(html);
    const hasTime = /<time[\s>]/i.test(html);

    // Facts that exist only in image alt text, not in the page's text.
    const text = innerText(html);
    const factAlts = [...html.matchAll(/<img[^>]*\balt\s*=\s*["']([^"']+)["']/gi)]
        .map(m => m[1])
        .filter(alt => FACT_RE.test(alt));
    const factsOnlyInImages = factAlts.filter(alt => {
        const fact = alt.match(FACT_RE)?.[0];
        return fact && !text.includes(fact);
    });

    return {
        hasMain,
        headings: headings.length,
        questionHeadings,
        hasTable,
        hasTime,
        textLength: text.length,
        factsOnlyInImages,
    };
}

/**
 * Site-level extractability findings.
 * @param {{path: string, html?: string, extract?: object}[]} pages -
 *        pages with a precomputed `extract` profile.
 * @returns {import('./consistency.js').Finding[]}
 */
export function checkExtractability(pages) {
    const findings = [];
    const profiled = pages.filter(p => p.extract);
    if (profiled.length === 0) return findings;

    // 1. Semantic containers: pages without <main>/<article> leak nav
    //    and footer into every extracted chunk.
    const noMain = profiled.filter(p => !p.extract.hasMain);
    if (noMain.length > 0 && noMain.length / profiled.length > 0.2) {
        findings.push({
            id: 'extract-no-semantic-main',
            category: 'extractability',
            severity: noMain.length / profiled.length > 0.8 ? 'medium' : 'low',
            confidence: 'strong',
            title: 'Content not wrapped in semantic <main>/<article>',
            detail: `${noMain.length} of ${profiled.length} pages have no <main> or <article> element, so machines cannot cleanly separate content from navigation and footer.`,
            why: 'AI extraction pipelines strip page chrome; without semantic containers, boilerplate leaks into every extracted answer and dilutes it.',
            evidence: [{ value: 'No <main>/<article>', pages: noMain.slice(0, 12).map(p => p.path), count: noMain.length }],
            pagesAffected: noMain.length,
        });
    }

    // 2. Answer-readiness: not a single question-shaped heading or FAQ
    //    section anywhere on the site.
    const withQuestions = profiled.filter(p => p.extract.questionHeadings > 0);
    if (withQuestions.length === 0 && profiled.length >= 5) {
        findings.push({
            id: 'extract-no-question-headings',
            category: 'extractability',
            severity: 'low',
            confidence: 'strong',
            title: 'No question-shaped headings or FAQ content',
            detail: `None of the ${profiled.length} pages has a heading phrased as a question. Question-shaped sections map directly onto what users ask AI assistants.`,
            why: 'Retrieval matches user questions against page sections; a section whose heading is the question is the easiest possible match.',
            evidence: [{ value: 'No question headings found', pages: [], count: 0 }],
            pagesAffected: profiled.length,
        });
    }

    // 3. Facts locked in images: alt text carries a phone/price the page
    //    text never states.
    const withImageFacts = profiled.filter(p => p.extract.factsOnlyInImages.length > 0);
    if (withImageFacts.length > 0) {
        findings.push({
            id: 'extract-facts-in-images',
            category: 'extractability',
            severity: 'medium',
            confidence: 'weak',
            title: 'Facts that only exist inside images',
            detail: 'Image alt text carries phone numbers or prices that never appear in the page text — the fact is invisible to most machine readers.',
            why: 'Most AI crawlers read text, not pixels. A price that lives only in an image cannot be quoted, so a competitor\'s text version wins.',
            evidence: withImageFacts.slice(0, MAX_EVIDENCE_ROWS).map(p => ({
                value: p.extract.factsOnlyInImages[0],
                pages: [p.path],
                count: p.extract.factsOnlyInImages.length,
            })),
            pagesAffected: withImageFacts.length,
        });
    }

    // 4. Machine-readable dates: nothing on the site declares <time>.
    const withTime = profiled.filter(p => p.extract.hasTime);
    if (withTime.length === 0 && profiled.length >= 5) {
        findings.push({
            id: 'extract-no-dates',
            category: 'extractability',
            severity: 'low',
            confidence: 'weak',
            title: 'No machine-readable dates anywhere on the site',
            detail: `No page uses a <time> element, so machines cannot tell fresh content from stale.`,
            why: 'Models weight recency; content without a trustworthy date is discounted against dated competitors.',
            evidence: [{ value: 'No <time> elements found', pages: [], count: 0 }],
            pagesAffected: profiled.length,
        });
    }

    return findings;
}

const MAX_EVIDENCE_ROWS = 12;
