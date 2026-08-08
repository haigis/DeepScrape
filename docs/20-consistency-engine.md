# Content consistency engine (issue #21)

`GET /scan/consistency?scan=<domain>/<date>` — cross-page analysis producing
scored, evidenced findings. This is the analytical core behind the SaaS: it
looks for places where a site contradicts itself, because contradictions are
what stop a search engine or language model stating your facts with
confidence.

## Output

```jsonc
{
  "pages": 63,
  "score": 26,                       // 100 minus weighted penalties
  "summary": { "high": 3, "medium": 5, "low": 4 },
  "byCategory": { "facts": 4, "metadata": 6, "structured-data": 1, "terminology": 1 },
  "findings": [
    {
      "id": "contradictory-phone-numbers",
      "category": "facts",
      "severity": "high",
      "title": "25 different phone numbers across the site",
      "detail": "…",
      "why": "Search engines and assistants pick one number to show…",
      "evidence": [{ "value": "0800 66 55 11", "pages": ["…"], "count": 12 }],
      "pagesAffected": 41
    }
  ]
}
```

Every finding carries **why it matters**, not just what it is — the report is
meant to be handed to a content team.

## The four families

**Facts** — phone numbers, emails, postcodes and prices extracted from visible
text and compared across the whole site. Comparison is normalised (digits-only
for phones, whitespace-insensitive postcodes) so *formatting* differences never
register as contradictions; only genuinely different values do.

**Metadata** — duplicate titles / H1s / meta descriptions, missing titles /
descriptions / H1s, multiple H1s, title-vs-H1 mismatch, canonical pointing
away from the page, and noindex pages.

**Structured data** — JSON-LD extracted from every page (including `@graph`
containers): none at all, partial coverage, blocks that fail to parse, and
`Organization` fields (`name`, `telephone`, `email`, `legalName`) declared
differently on different pages — a site contradicting its own machine-readable
identity.

**Terminology** — the same destination linked under three or more different
labels, using the inbound index. Generic wayfinding text ("read more", "click
here", "home") is excluded so only real naming drift surfaces.

Scoring: high 12, medium 6, low 2 penalty points, floored at 0. Results are
cached per scan and invalidated by the scan's file fingerprint
(`getScanToken`).

## Verified

**Unit (11 tests, suite 95/95):** a purpose-built five-page fixture covering
contradictory phones and postcodes, duplicate titles/descriptions, missing and
multiple H1s, canonical conflict, noindex, invalid JSON-LD, partial coverage,
conflicting `Organization` names, the no-structured-data case, the empty scan,
and — importantly — a negative test proving `0800 111 2222` and `0800 1112222`
are **not** reported as a contradiction.

**Real site** (`www.nationwide.co.uk`, 63 pages, 0.29s): score **26/100** —
25 distinct phone numbers, 11 contact emails, 4 postcodes, JSON-LD on only 62%
of pages, duplicate H1s and descriptions, 2 canonical conflicts, and 49 pages
referred to by three or more names (e.g. *"Download our app" · "Get our app" ·
"Explore and download our app" · "safe and secure app"*).
