// scripts/test-local.mjs
// Quick smoke-test against the local dev server (vercel dev)
// Usage: node scripts/test-local.mjs

const ENDPOINT = process.env.TEST_URL ?? 'http://localhost:3000/api/generate-pdf';

// Minimal album HTML — one A5 page, black background, white text
const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  .pg{width:148mm;height:210mm;background:#1a1a1a;position:relative;
      page-break-after:always;break-after:page;display:flex;
      align-items:center;justify-content:center;}
  span{color:#fff;font-size:32px;font-family:sans-serif;}
  @media print{@page{size:148mm 210mm;margin:0}}
</style></head><body>
<div class="pg"><span>Test Page 1 ✓</span></div>
<div class="pg"><span>Test Page 2 ✓</span></div>
</body></html>`;

console.log(`\nPOSTing to ${ENDPOINT} …\n`);

try {
  const res = await fetch(ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html }),
  });

  const json = await res.json();

  if (!res.ok) {
    console.error('❌ Error response:', res.status, json);
    process.exit(1);
  }

  if (!json.fileUrl) {
    console.error('❌ No fileUrl in response:', json);
    process.exit(1);
  }

  console.log('✅ Success!');
  console.log('   fileUrl:', json.fileUrl);
  console.log('\nOpen the URL above in a browser to verify the PDF.\n');

} catch (err) {
  console.error('❌ Request failed:', err.message);
  console.error('   Is the dev server running? → vercel dev');
  process.exit(1);
}
