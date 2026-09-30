// Renders static/og.png (1200x630, the link-preview image) from the HTML below with headless
// Chromium. No external assets: system fonts, inline SVG. Run: node scripts/og-image.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const html = `<!doctype html><html><body style="margin:0;width:1200px;height:630px;background:#0b0f14;color:#d9e4ee;font-family:ui-monospace,Menlo,monospace;display:flex;align-items:center">
<div style="padding:0 80px;flex:1">
  <div style="display:inline-block;color:#ff5c6c;border:3px solid #ff5c6c;padding:4px 14px;transform:rotate(-2deg);font-weight:800;letter-spacing:4px;font-size:22px">SUPER SECRET</div>
  <div style="font-size:74px;font-weight:800;color:#39ff88;margin-top:34px;letter-spacing:2px">SUPER SECRET <span style="color:#ffcf3f">NOTES</span></div>
  <div style="font-size:30px;color:#8aa0b4;margin-top:6px">by GaussRun</div>
  <div style="font-size:30px;margin-top:40px;line-height:1.35;max-width:1000px">A note you cannot afford to lose. Saved on a dozen independent hosts, encrypted before it leaves, recoverable anywhere.</div>
</div>
<svg width="230" height="630" viewBox="0 0 230 630" style="margin-right:40px">
  ${[0, 1, 2, 3].map((i) => `<rect x="${20 + i * 18}" y="${150 + i * 45}" width="${190 - i * 36}" height="${330 - i * 90}" rx="16" fill="none" stroke="${['#5cd6ff', '#39ff88', '#ffcf3f', '#d9e4ee'][i]}" stroke-width="5" ${i === 3 ? 'stroke-dasharray="10 8"' : ''}/>`).join('')}
</svg></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: fileURLToPath(new URL('../static/og.png', import.meta.url)) });
await browser.close();
