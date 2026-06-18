// server.js
// Express server for Railway (and any other persistent-process host)
// Replaces the Vercel serverless api/generate-pdf.js handler
//
// Routes:
//   GET  /health            → { status: "ok" }
//   POST /api/generate-pdf  → { fileUrl: string }

import express              from 'express';
import chromium             from '@sparticuz/chromium';
import puppeteer            from 'puppeteer-core';
import { v2 as cloudinary } from 'cloudinary';
import { Readable }         from 'stream';
import { existsSync }       from 'fs';

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

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Parse JSON bodies — Railway/Express doesn't have Vercel's automatic parsing.
// 50 MB limit to accommodate base64-encoded photos embedded in HTML.
app.use(express.json({ limit: '50mb' }));

// CORS — allow any origin (tighten to your Shopify domain in production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── POST /api/generate-pdf ────────────────────────────────────────────────────
app.post('/api/generate-pdf', async (req, res) => {
  // ── Validate input ──────────────────────────────────────────────────────────
  const { html } = req.body ?? {};

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid body field: html (string required)' });
  }

  if (html.length > 50_000_000) {
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
    // ── Resolve Chromium executable ───────────────────────────────────────────────
    // Priority:
    //   1. CHROMIUM_PATH env var        — explicit override via Railway dashboard
    //   2. /usr/bin/chromium-browser    — standard Debian/Ubuntu package
    //   3. /usr/bin/google-chrome       — if Google Chrome is installed instead
    //   4. @sparticuz/chromium          — bundled binary (always available, last resort)
    const SYSTEM_PATHS = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];

    const executablePath =
      process.env.CHROMIUM_PATH ||
      SYSTEM_PATHS.find(p => existsSync(p)) ||
      await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',          // avoids /dev/shm size issues in containers
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        // Note: '--single-process' is intentionally omitted for Railway.
        // It was required on Vercel Lambda (no fork) but causes instability
        // on persistent-process hosts that do have proper process support.
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30_000);

    // Load the HTML directly — base64 images are inline so no network needed
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout:   30_000,
    });

    // Wait for any lazily-decoded images
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
      printBackground: true,
      margin: {
        top:    '0',
        right:  '0',
        bottom: '0',
        left:   '0',
      },
    });

    await browser.close();
    browser = null;

    // ── Upload to Cloudinary ──────────────────────────────────────────────────
    const timestamp = Date.now();
    const suffix    = Math.random().toString(36).slice(2, 8);
    const filename  = `album_${timestamp}_${suffix}.pdf`;

    const uploadResult = await uploadToCloudinary(pdfBuffer, filename);
    const fileUrl      = uploadResult.secure_url;

    console.log(`[generate-pdf] uploaded: ${fileUrl} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    return res.status(200).json({ fileUrl });

  } catch (err) {
    console.error('[generate-pdf] error:', err);

    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    if (err.message?.includes('Protocol error') || err.message?.includes('Target closed')) {
      return res.status(500).json({ error: 'PDF generation failed: browser crashed. Try reducing image count.' });
    }
    if (err.message?.includes('cloudinary') || err.http_code) {
      return res.status(502).json({ error: 'PDF upload failed: Cloudinary error.', detail: err.message });
    }

    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
