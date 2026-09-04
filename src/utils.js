export async function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Work to finish before the process exits on SIGTERM/SIGINT. Running
 * crawls register their checkpoint flush here, so a redeploy loses the
 * seconds since the last page rather than the whole interval between
 * periodic checkpoints. Each hook is a function returning a promise.
 */
export const shutdownHooks = new Set();

/**
 * Runs every shutdown hook, capped so a hook that hangs cannot hold the
 * container past the orchestrator's kill deadline.
 * @param {number} capMs
 */
export async function runShutdownHooks(capMs = 5000) {
    const hooks = [...shutdownHooks];
    if (hooks.length === 0) return;
    await Promise.race([
        Promise.allSettled(hooks.map(fn => Promise.resolve().then(fn))),
        waitMs(capMs),
    ]);
}
