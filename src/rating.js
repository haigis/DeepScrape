/**
 * Coherence rating v2.
 *
 * Three properties a score must have before a customer will defend it
 * internally:
 *
 *  1. Trustworthy — versioned methodology, normalised by site size so a
 *     10-page and a 3,000-page site are comparable.
 *  2. Explainable — every lost point is attributed to a specific
 *     finding; attributions sum exactly to the points lost.
 *  3. Actionable — the attribution is the projected gain for fixing
 *     that finding, which is what the task list sells.
 */

export const METHODOLOGY_VERSION = 'rating.v2';

/**
 * Pillar weights. Facts weigh most: factual contradictions are what
 * most directly poison AI answers about a business.
 */
export const PILLARS = Object.freeze({
    facts: { label: 'Contradictory facts', weight: 0.35 },
    metadata: { label: 'Metadata conflicts', weight: 0.25 },
    'structured-data': { label: 'Structured data', weight: 0.25 },
    terminology: { label: 'Terminology drift', weight: 0.15 },
});

/** Base cost of one finding at full spread, by severity. */
const SEVERITY_COST = { high: 45, medium: 22, low: 8 };

/**
 * Spread multiplier: how much of the site a finding touches.
 * sqrt so the first affected pages hurt most — one contradiction on
 * 10% of pages is already a real problem, not a tenth of one.
 * Floor keeps even a single-page finding meaningful.
 */
function spreadFactor(pagesAffected, totalPages) {
    if (!totalPages) return 1;
    const proportion = Math.min(1, (pagesAffected || 1) / totalPages);
    return Math.max(0.25, Math.sqrt(proportion));
}

export const gradeOf = (score) =>
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

/**
 * Rates a scan's findings.
 *
 * @param {import('./consistency.js').Finding[]} findings
 * @param {number} totalPages
 * @returns {{
 *   methodologyVersion: string,
 *   score: number, grade: string,
 *   pillars: Record<string, {label: string, weight: number, score: number,
 *                            lostPoints: number, findings: number}>,
 *   attribution: {findingId: string, pillar: string, pointsCost: number}[],
 *   verdict: string,
 * }}
 */
// --- Rating v3 (shadow) ----------------------------------------------------
// Six pillars; cost = severityBase × reach × confidence. Runs alongside
// v2 while calibrating (docs/scoring-methodology-v3.md in coherence).

export const METHODOLOGY_VERSION_V3 = 'rating.v3-shadow';

export const PILLARS_V3 = Object.freeze({
    access: { label: 'Access & rendering', weight: 0.15 },
    facts: { label: 'Fact consistency', weight: 0.30 },
    metadata: { label: 'Metadata integrity', weight: 0.15 },
    'structured-data': { label: 'Structured data', weight: 0.15 },
    terminology: { label: 'Terminology & entities', weight: 0.10 },
    extractability: { label: 'Extractability', weight: 0.15 },
});

const SEVERITY_BASE_V3 = { high: 15, medium: 8, low: 3 };
const CONFIDENCE_V3 = { confirmed: 1.0, strong: 0.6, weak: 0.3 };

/**
 * Reach: share of the site a finding touches, floored so big sites
 * cannot dilute a real contradiction to nothing, saturating once ~10%
 * of the site (or 5 pages) is affected.
 */
export function reachFactor(pagesAffected, totalPages) {
    if (!totalPages) return 1;
    const saturation = Math.max(5, 0.1 * totalPages);
    return 0.25 + 0.75 * Math.min(1, (pagesAffected || 1) / saturation);
}

/**
 * Rates findings under the v3 methodology. Findings may carry a
 * `confidence` tag ('confirmed' | 'strong' | 'weak'); untagged findings
 * count as confirmed (v2 checks are exact-value by construction).
 */
export function rateFindingsV3(findings, totalPages) {
    const pillars = {};
    for (const [id, def] of Object.entries(PILLARS_V3)) {
        pillars[id] = { label: def.label, weight: def.weight, raw: 0, findings: 0 };
    }

    const rawCosts = [];
    for (const finding of findings) {
        const pillar = pillars[finding.category] ? finding.category : 'metadata';
        const cost = SEVERITY_BASE_V3[finding.severity]
            * reachFactor(finding.pagesAffected, totalPages)
            * (CONFIDENCE_V3[finding.confidence] ?? 1.0);
        pillars[pillar].raw += cost;
        pillars[pillar].findings += 1;
        rawCosts.push({ findingId: finding.id, pillar, raw: cost });
    }

    const attribution = [];
    for (const [id, pillar] of Object.entries(pillars)) {
        const capped = Math.min(100, pillar.raw);
        pillar.score = Math.round(100 - capped);
        pillar.lostPoints = 100 - pillar.score;

        const pillarRaw = pillar.raw || 1;
        let allocated = 0;
        const mine = rawCosts.filter(c => c.pillar === id);
        mine.forEach((cost, index) => {
            let points;
            if (index === mine.length - 1) {
                points = Math.round((pillar.lostPoints - allocated) * 10) / 10;
            } else {
                points = Math.round((cost.raw / pillarRaw) * pillar.lostPoints * 10) / 10;
                allocated += points;
            }
            attribution.push({ findingId: cost.findingId, pillar: id, pointsCost: Math.max(0, points) });
        });
        delete pillar.raw;
    }

    const score = Math.round(
        Object.values(pillars).reduce((sum, pillar) => sum + pillar.score * pillar.weight, 0),
    );

    const worst = Object.entries(pillars)
        .filter(([, p]) => p.lostPoints > 0)
        .sort((a, b) => b[1].lostPoints * b[1].weight - a[1].lostPoints * a[1].weight)[0];
    const verdict = worst
        ? `${worst[1].label}: ${worst[1].findings} finding${worst[1].findings === 1 ? '' : 's'} losing ${Math.round(worst[1].lostPoints * worst[1].weight)} weighted points.`
        : 'No coherence problems found — the site speaks with one voice.';

    return {
        methodologyVersion: METHODOLOGY_VERSION_V3,
        score,
        grade: gradeOf(score),
        pillars,
        attribution,
        verdict,
    };
}

export function rateFindings(findings, totalPages) {
    const pillars = {};
    for (const [id, def] of Object.entries(PILLARS)) {
        pillars[id] = { label: def.label, weight: def.weight, raw: 0, findings: 0 };
    }

    // Raw cost per pillar, with per-finding attribution.
    const rawCosts = [];
    for (const finding of findings) {
        const pillar = pillars[finding.category] ? finding.category : 'metadata';
        const cost = SEVERITY_COST[finding.severity] * spreadFactor(finding.pagesAffected, totalPages);
        pillars[pillar].raw += cost;
        pillars[pillar].findings += 1;
        rawCosts.push({ findingId: finding.id, pillar, raw: cost });
    }

    // Convert raw cost to a 0–100 pillar score. Cost saturates: beyond
    // ~100 raw points a pillar is simply failed, and additional findings
    // stop moving the number (they still appear in the attribution).
    const attribution = [];
    for (const [id, pillar] of Object.entries(pillars)) {
        const capped = Math.min(100, pillar.raw);
        pillar.score = Math.round(100 - capped);
        pillar.lostPoints = 100 - pillar.score;

        // Scale each finding's raw cost so attributions sum exactly to
        // the pillar's lost points (explainability requirement).
        const pillarRaw = pillar.raw || 1;
        let allocated = 0;
        const mine = rawCosts.filter(c => c.pillar === id);
        mine.forEach((cost, index) => {
            let points;
            if (index === mine.length - 1) {
                points = Math.round((pillar.lostPoints - allocated) * 10) / 10;
            } else {
                points = Math.round((cost.raw / pillarRaw) * pillar.lostPoints * 10) / 10;
                allocated += points;
            }
            attribution.push({ findingId: cost.findingId, pillar: id, pointsCost: Math.max(0, points) });
        });
        delete pillar.raw;
    }

    const score = Math.round(
        Object.values(pillars).reduce((sum, pillar) => sum + pillar.score * pillar.weight, 0),
    );

    // One-line verdict: the costliest pillar, named plainly.
    const worst = Object.entries(pillars)
        .filter(([, p]) => p.lostPoints > 0)
        .sort((a, b) => b[1].lostPoints * b[1].weight - a[1].lostPoints * a[1].weight)[0];
    const verdict = worst
        ? `${worst[1].label} ${worst[1].lostPoints >= 50 ? 'are your biggest cost' : 'cost you the most'} — ${worst[1].findings} finding${worst[1].findings === 1 ? '' : 's'} losing ${Math.round(worst[1].lostPoints * worst[1].weight)} weighted points.`
        : 'No coherence problems found — the site speaks with one voice.';

    return {
        methodologyVersion: METHODOLOGY_VERSION,
        score,
        grade: gradeOf(score),
        pillars,
        attribution,
        verdict,
    };
}
