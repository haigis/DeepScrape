/**
 * Shared Puppeteer launch options.
 *
 * Chrome refuses to start as root with its sandbox enabled, and the
 * container runs as root, so every launch needs these flags. They lived
 * in only one of the two launch sites, which is why scans failed with
 * "Running as root without --no-sandbox is not supported" while the
 * accessibility checks worked. One definition means the two cannot
 * drift apart again.
 *
 * Note: --no-sandbox is a real reduction in isolation for a crawler that
 * visits arbitrary external sites. The better fix is to run the
 * container as a non-root user so the sandbox can stay on; until then
 * these flags are required for Chrome to start at all.
 */
export const BROWSER_LAUNCH_OPTIONS = Object.freeze({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
