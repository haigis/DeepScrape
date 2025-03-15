import sharp from 'sharp';

export async function captureWebpScreenshot(page, outPath) {
    const pngBuf = await page.screenshot({ fullPage: true, type: 'png' });
    await sharp(pngBuf).webp({ quality: 90 }).toFile(outPath);
}
