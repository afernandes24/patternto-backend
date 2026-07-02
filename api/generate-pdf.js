// api/generate-pdf.js
// Vercel serverless function: HTML → PDF (Puppeteer) → Cloudinary → URL
//
// POST /api/generate-pdf
// Body: { html: string }
// Returns: { fileUrl: string }

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

// ── Cloudinary config ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Upload helper: Buffer → Cloudinary (raw) ──────────────────────────────────
function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        public_id:     filename,
        folder:        'album-pdfs',
        overwrite:     true,
        // Make the file publicly accessible
        type:          'upload',
        access_mode:   'public',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    Readable.from(buffer).pipe(uploadStream);
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers (adjust origin in production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── Validate input ──────────────────────────────────────────────────────────
  const { html } = req.body ?? {};

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid body field: html (string required)' });
  }

  if (html.length > 50_000_000) { // 50 MB safety cap (base64 photos are large)
    return res.status(413).json({ error: 'HTML payload too large (max 50 MB)' });
  }

  // ── Validate Cloudinary env vars ────────────────────────────────────────────
  const missingEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
    .filter(k => !process.env[k]);

  if (missingEnv.length) {
    console.error('Missing env vars:', missingEnv);
    return res.status(500).json({ error: `Server misconfiguration: missing ${missingEnv.join(', ')}` });
  }

  let browser = null;

  try {
    // ── Launch Chromium ───────────────────────────────────────────────────────
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Increase timeout for pages with many base64 images
    page.setDefaultNavigationTimeout(30_000);

    // Load HTML directly (no network round-trip; base64 images are inline)
    await page.setContent(html, {
      waitUntil: 'networkidle0', // wait until no network activity for 500ms
      timeout:   30_000,
    });

    // Optional: wait for all images to finish decoding
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images)
          .filter(img => !img.complete)
          .map(img => new Promise(resolve => {
            img.onload = img.onerror = resolve;
          }))
      )
    );

    // ── Generate PDF ──────────────────────────────────────────────────────────
    const pdfBuffer = await page.pdf({
      width:           '148mm',
      height:          '210mm',
      printBackground: true,    // render background colours and images
      margin: {
        top:    '0',
        right:  '0',
        bottom: '0',
        left:   '0',
      },
      // Each page in the HTML already has page-break-after:always
      // so Puppeteer will produce one PDF page per .pg div
    });

    await browser.close();
    browser = null;

    // ── Upload to Cloudinary ──────────────────────────────────────────────────
    // Unique filename: timestamp + short random suffix
    const timestamp = Date.now();
    const suffix    = Math.random().toString(36).slice(2, 8);
    const filename  = `album_${timestamp}_${suffix}.pdf`;

    const uploadResult = await uploadToCloudinary(pdfBuffer, filename);

    // Cloudinary raw uploads return secure_url with resource_type=raw
    const fileUrl = uploadResult.secure_url;

    console.log(`PDF generated and uploaded: ${fileUrl} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    return res.status(200).json({ fileUrl });

  } catch (err) {
    console.error('generate-pdf error:', err);

    // Close browser if still open after error
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    // Distinguish known error types for better client messages
    if (err.message?.includes('Protocol error') || err.message?.includes('Target closed')) {
      return res.status(500).json({ error: 'PDF generation failed: browser crashed. Try reducing image count.' });
    }
    if (err.message?.includes('cloudinary') || err.http_code) {
      return res.status(502).json({ error: 'PDF upload failed: Cloudinary error.', detail: err.message });
    }

    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
