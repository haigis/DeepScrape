import { promises as fs } from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

/**
 * Q&A extraction (issue #54 in coherence).
 *
 * Pulls question/answer pairs out of saved pages deterministically —
 * no AI, no network. Sources in priority order:
 *
 *   1. FAQPage JSON-LD (machine-declared: the gold standard)
 *   2. <details><summary>            (native accordions)
 *   3. <dt>/<dd>                     (definition lists)
 *   4. Question-shaped h2/h3 + text  (until the next heading)
 *   5. Custom CSS selector pairs     (per-group accordion/tile markup)
 *
 * Also produces heading-scoped text chunks for the whole scan — the
 * corpus the matching pass searches for answers elsewhere on the site.
 */

const QUESTION_RE = /^(how|what|why|when|where|who|which|can|do|does|is|are|should)\b|\?\s*$/i;

const MAX_ANSWER_CHARS = 2000;
const MAX_CHUNK_CHARS = 1500;
const MIN_TEXT_CHARS = 20;

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Question identity: lowercase, no punctuation, so re-scans match. */
export const questionKey = (question) =>
    clean(question).toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

/** FAQPage / Question JSON-LD nodes. */
function fromJsonLd($) {
    const pairs = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        let parsed;
        try {
            parsed = JSON.parse($(el).text());
        } catch {
            return;
        }
        const nodes = [];
        for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
            if (node && typeof node === 'object') nodes.push(node);
            if (Array.isArray(node?.['@graph'])) nodes.push(...node['@graph']);
        }
        for (const node of nodes) {
            const type = String(node['@type'] ?? '');
            const questions = /FAQPage/i.test(type)
                ? (Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity]).filter(Boolean)
                : /^Question$/i.test(type) ? [node] : [];
            for (const q of questions) {
                const question = clean(q?.name);
                const answerRaw = q?.acceptedAnswer?.text ?? q?.acceptedAnswer?.name;
                const answer = clean(typeof answerRaw === 'string' ? answerRaw.replace(/<[^>]+>/g, ' ') : '');
                if (question && answer) pairs.push({ question, answer, extractor: 'jsonld' });
            }
        }
    });
    return pairs;
}

function fromDetails($) {
    const pairs = [];
    $('details').each((_, el) => {
        const details = $(el);
        const question = clean(details.find('summary').first().text());
        const body = details.clone();
        body.find('summary').remove();
        const answer = clean(body.text()).slice(0, MAX_ANSWER_CHARS);
        if (question && answer.length >= MIN_TEXT_CHARS) pairs.push({ question, answer, extractor: 'details' });
    });
    return pairs;
}

function fromDefinitionLists($) {
    const pairs = [];
    $('dl').each((_, dl) => {
        $(dl).children('dt').each((_, dt) => {
            const question = clean($(dt).text());
            const answer = clean($(dt).nextUntil('dt', 'dd').text()).slice(0, MAX_ANSWER_CHARS);
            if (question && answer.length >= MIN_TEXT_CHARS && QUESTION_RE.test(question)) {
                pairs.push({ question, answer, extractor: 'dl' });
            }
        });
    });
    return pairs;
}

function fromHeadings($) {
    const pairs = [];
    $('h2, h3').each((_, el) => {
        const heading = $(el);
        const question = clean(heading.text());
        if (!question || !QUESTION_RE.test(question)) return;
        // Answer: siblings until the next heading of same-or-higher rank.
        const parts = [];
        let node = heading.next();
        while (node.length && !/^h[1-3]$/i.test(node.prop('tagName') ?? '')) {
            parts.push(clean(node.text()));
            node = node.next();
        }
        const answer = clean(parts.join(' ')).slice(0, MAX_ANSWER_CHARS);
        if (answer.length >= MIN_TEXT_CHARS) pairs.push({ question, answer, extractor: 'heading' });
    });
    return pairs;
}

/** Custom accordion/tile markup: per-group selector pairs. */
function fromSelectors($, selectors) {
    const pairs = [];
    for (const rule of selectors) {
        const container = rule.container ?? null;
        const qSel = rule.question;
        const aSel = rule.answer;
        if (!qSel || !aSel) continue;
        const scope = container ? $(container) : $.root();
        scope.each((_, el) => {
            const root = $(el);
            if (container) {
                const question = clean(root.find(qSel).first().text());
                const answer = clean(root.find(aSel).first().text()).slice(0, MAX_ANSWER_CHARS);
                if (question && answer.length >= MIN_TEXT_CHARS) pairs.push({ question, answer, extractor: 'selector' });
            } else {
                // No container: pair questions and answers by index.
                const questions = root.find(qSel).toArray().map(q => clean($(q).text()));
                const answers = root.find(aSel).toArray().map(a => clean($(a).text()).slice(0, MAX_ANSWER_CHARS));
                questions.forEach((question, i) => {
                    const answer = answers[i];
                    if (question && answer && answer.length >= MIN_TEXT_CHARS) {
                        pairs.push({ question, answer, extractor: 'selector' });
                    }
                });
            }
        });
    }
    return pairs;
}

/**
 * Q&A pairs from one page's HTML. First extractor to claim a question
 * (by normalised identity) wins — JSON-LD beats scraping the DOM.
 * @param {string} html
 * @param {{container?: string, question: string, answer: string}[]} [selectors]
 */
export function extractQa(html, selectors = []) {
    const $ = cheerio.load(html);
    const all = [
        ...fromJsonLd($),
        ...fromDetails($),
        ...fromDefinitionLists($),
        ...fromHeadings($),
        ...fromSelectors($, selectors),
    ];
    const seen = new Map();
    for (const pair of all) {
        const key = questionKey(pair.question);
        if (key && !seen.has(key)) seen.set(key, pair);
    }
    return [...seen.values()];
}

/**
 * Heading-scoped chunks from one page — the searchable corpus.
 * @param {string} html
 */
export function extractChunks(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header').remove();
    const chunks = [];

    $('h1, h2, h3').each((_, el) => {
        const heading = clean($(el).text());
        const parts = [];
        let node = $(el).next();
        while (node.length && !/^h[1-3]$/i.test(node.prop('tagName') ?? '')) {
            parts.push(clean(node.text()));
            node = node.next();
        }
        const text = clean(parts.join(' ')).slice(0, MAX_CHUNK_CHARS);
        if (heading && text.length >= MIN_TEXT_CHARS * 2) chunks.push({ heading, text });
    });

    // Pages with no headings still contribute one body chunk.
    if (chunks.length === 0) {
        const body = clean($('main').text() || $('body').text()).slice(0, MAX_CHUNK_CHARS);
        if (body.length >= MIN_TEXT_CHARS * 2) chunks.push({ heading: null, text: body });
    }
    return chunks;
}

/**
 * Extracts Q&A pairs and chunks across a scan directory.
 * @param {string} scanPath
 * @param {{qaPaths?: string[], selectors?: object[]}} opts -
 *        qaPaths: page-path prefixes that are Q&A sources (the group);
 *        pairs come only from those, chunks come from every page.
 */
export async function extractScanQa(scanPath, opts = {}) {
    const qaPaths = (opts.qaPaths ?? []).map(p => p.replace(/^\/+/, ''));
    const selectors = opts.selectors ?? [];
    const pairs = [];
    const chunks = [];

    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name !== 'images' && entry.name !== '_assets') await walk(path.join(dir, entry.name), childRel);
                continue;
            }
            if (!/\.html?$/i.test(entry.name)) continue;
            const html = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => null);
            if (!html) continue;

            for (const chunk of extractChunks(html)) chunks.push({ page: childRel, ...chunk });

            const isQaSource = qaPaths.length === 0
                ? false
                : qaPaths.some(p => childRel === p || childRel.startsWith(p.replace(/\/$/, '') + '/')
                    || childRel.replace(/\.html?$/i, '') === p.replace(/\.html?$/i, ''));
            if (isQaSource) {
                for (const pair of extractQa(html, selectors)) pairs.push({ ...pair, sourcePage: childRel });
            }
        }
    }
    await walk(scanPath, '');

    // Site-wide dedupe: the same question on two FAQ pages is one pair.
    const seen = new Map();
    for (const pair of pairs) {
        const key = questionKey(pair.question);
        if (key && !seen.has(key)) seen.set(key, pair);
    }
    return { pairs: [...seen.values()], chunks };
}
