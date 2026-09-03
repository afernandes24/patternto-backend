-- 001_create_albums.sql
-- Fundament pod zapis roboczych albumów (draft save)

BEGIN;

-- ── Tabela albums ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS albums (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id   text        NOT NULL,
  title                 text        NOT NULL DEFAULT 'Bez nazwy',
  cover_thumbnail_url   text,
  pages_json            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  product_format        text,                     -- np. "30-page", "60-page"
  page_count            int,
  status                text        NOT NULL DEFAULT 'draft',  -- 'draft' | 'ordered'
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Indeks do listowania albumów danego klienta ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_albums_shopify_customer_id
  ON albums (shopify_customer_id);

-- ── Trigger: updated_at = now() przy każdym UPDATE ───────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_albums_updated_at ON albums;
CREATE TRIGGER trg_albums_updated_at
  BEFORE UPDATE ON albums
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Tabela śledzenia migracji ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _migrations (
  name       text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _migrations (name) VALUES ('001_create_albums')
  ON CONFLICT (name) DO NOTHING;

COMMIT;
