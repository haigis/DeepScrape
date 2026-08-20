/**
 * Shared Puppeteer launch options.
 *
 * One definition for both launch sites. They diverged once before, and
 * scans failed while the accessibility checks kept working, which took
 * far longer to spot than it should have.
 *
 * On --no-sandbox: the container runs as a non-root user, which is worth
 * having on its own, but Chrome's sandbox still cannot start here.
 * Ubuntu 24.04 and later restrict unprivileged user namespaces through
 * AppArmor, and the sandbox needs them:
 *
 *     FATAL:zygote_host_impl_linux.cc No usable sandbox!
 *
 * The ways to get it back are all worse than the flag. --cap-add=SYS_ADMIN
 * grants more than the sandbox removes. Relaxing
 * kernel.apparmor_restrict_unprivileged_userns weakens the whole host,
 * which also runs unrelated production services.
 *
 * So the isolation here is the container plus a non-root user, not the
 * Chrome sandbox. Worth revisiting if this ever runs somewhere the
 * sandbox is available — the flag can then just be deleted.
 *
 * --disable-dev-shm-usage stays regardless: /dev/shm is small in
 * containers and Chrome crashes without it on heavy pages.
 */
export const BROWSER_LAUNCH_OPTIONS = Object.freeze({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
