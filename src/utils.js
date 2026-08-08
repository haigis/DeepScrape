export async function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
