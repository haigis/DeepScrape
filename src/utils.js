export async function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function readUrlsFromSitemap(sitemapUrl) {
    const axios = (await import('axios')).default;
    const xml2js = (await import('xml2js')).default;
    
    const { data } = await axios.get(sitemapUrl);
    const parsed = await xml2js.parseStringPromise(data);
    
    return parsed.urlset.url.map(entry => entry.loc[0]);
}
