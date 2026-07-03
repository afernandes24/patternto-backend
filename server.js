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
import { existsSync }       from 'fs';
import fs                   from 'fs/promises';
import path                 from 'path';
import { fileURLToPath }    from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── PDF storage (Railway Volume) ────────────────────────────────────────────
// PDF_STORAGE_DIR musi wskazywać na ścieżkę zamontowanego Volume w Railway
// (Settings → Volumes → Mount Path, np. "/data"). Domyślnie "/data/pdfs".
const PDF_DIR = process.env.PDF_STORAGE_DIR || '/data/pdfs';

// Bazowy publiczny URL używany do budowania linku do pliku (Gelato/Shopify
// muszą mieć dostęp z zewnątrz). Domyślnie ta sama domena Railway co reszta API.
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  'https://patternto-backend-production.up.railway.app';

// Ile dni trzymamy wygenerowane PDF-y zanim zostaną automatycznie usunięte.
const RETENTION_DAYS = parseInt(process.env.PDF_RETENTION_DAYS || '60', 10);

async function ensurePdfDir() {
  await fs.mkdir(PDF_DIR, { recursive: true });
}

// ── Sprzątanie starych plików (żeby Volume się nie zapychał) ────────────────
async function cleanupOldFiles() {
  try {
    await ensurePdfDir();
    const files = await fs.readdir(PDF_DIR);
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      const fp = path.join(PDF_DIR, f);
      const stat = await fs.stat(fp);
      const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > RETENTION_DAYS) {
        await fs.unlink(fp);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[cleanup] usunięto ${removed} plik(ów) starszych niż ${RETENTION_DAYS} dni`);
    }
  } catch (err) {
    console.error('[cleanup] błąd:', err);
  }
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

// ── Static assets (logo, stickers) ──────────────────────────────────────────
// Served at https://<railway-domain>/assets/... — used by the editor frontend
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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

    // ── Zapis na Railway Volume ─────────────────────────────────────────────
    await ensurePdfDir();

    const timestamp = Date.now();
    const suffix    = Math.random().toString(36).slice(2, 8);
    const filename  = `album_${timestamp}_${suffix}.pdf`;
    const filePath  = path.join(PDF_DIR, filename);

    await fs.writeFile(filePath, pdfBuffer);

    const fileUrl = `${PUBLIC_BASE_URL}/files/${filename}`;

    console.log(`[generate-pdf] saved: ${fileUrl} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    return res.status(200).json({ fileUrl });

  } catch (err) {
    console.error('[generate-pdf] error:', err);

    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    if (err.message?.includes('Protocol error') || err.message?.includes('Target closed')) {
      return res.status(500).json({ error: 'PDF generation failed: browser crashed. Try reducing image count.' });
    }
    if (err.code === 'ENOSPC') {
      return res.status(507).json({ error: 'Storage full: Railway Volume out of space.' });
    }

    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ── GET /files/:filename — serwuje zapisane PDF-y (Gelato/Shopify je stąd pobierają) ──
app.get('/files/:filename', async (req, res) => {
  // Zabezpieczenie przed path traversal (np. ../../etc/passwd)
  const filename = path.basename(req.params.filename);
  const filePath = path.join(PDF_DIR, filename);

  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(filePath);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[server] listening on port ${PORT}`);
  console.log(`[server] PDF storage dir: ${PDF_DIR}`);
  console.log(`[server] public base URL: ${PUBLIC_BASE_URL}`);
  await ensurePdfDir();
  cleanupOldFiles(); // raz przy starcie
  setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000); // potem raz dziennie
});
