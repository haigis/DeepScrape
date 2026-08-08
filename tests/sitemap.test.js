import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { fetchSitemapUrls } from '../src/sitemap.js';

let server;
let base;

const urlset = (locs) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map(l => `  <url><loc>${l}</loc></url>`).join('\n')}
</urlset>`;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/sitemap.xml') {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/child-a.xml</loc></sitemap>
  <sitemap><loc>${base}/child-b.xml.gz</loc></sitemap>
</sitemapindex>`);
        } else if (req.url === '/child-a.xml') {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(urlset([`${base}/one`, `${base}/two`]));
        } else if (req.url === '/child-b.xml.gz') {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(zlib.gzipSync(Buffer.from(urlset([`${base}/two`, `${base}/three`]))));
        } else if (req.url === '/flat.xml') {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(urlset([`${base}/only`]));
        } else if (req.url === '/bad.xml') {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<?xml version="1.0"?><wrong></wrong>');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

describe('fetchSitemapUrls', () => {
    it('parses a flat urlset', async () => {
        const urls = await fetchSitemapUrls(`${base}/flat.xml`);
        expect(urls).toEqual([`${base}/only`]);
    });

    it('recurses sitemap indexes, gunzips children and dedupes', async () => {
        const urls = await fetchSitemapUrls(`${base}/sitemap.xml`);
        expect(urls.sort()).toEqual([`${base}/one`, `${base}/three`, `${base}/two`].sort());
    });

    it('throws on unrecognised roots', async () => {
        await expect(fetchSitemapUrls(`${base}/bad.xml`)).rejects.toThrow(/Unrecognised sitemap format/);
    });

    it('throws on HTTP errors', async () => {
        await expect(fetchSitemapUrls(`${base}/missing.xml`)).rejects.toThrow();
    });
});
