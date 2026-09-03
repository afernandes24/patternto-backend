#!/usr/bin/env node
// scripts/migrate.mjs
// Prosty runner migracji — uruchamia *.sql z katalogu migrations/ po kolei,
// pomija te, które już są w tabeli _migrations.
//
// Użycie:  DATABASE_URL=postgres://... node scripts/migrate.mjs

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const ssl = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString, ssl });
  await client.connect();

  // Upewnij sie ze tabela _migrations istnieje (pierwsza migracja ja tworzy,
  // ale runner musi moc sprawdzic co juz bylo zastosowane)
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows: applied } = await client.query('SELECT name FROM _migrations ORDER BY name');
  const appliedSet = new Set(applied.map(r => r.name));

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    if (appliedSet.has(name)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  apply ${file} ...`);
    await client.query(sql);
    count++;
    console.log(`  done  ${file}`);
  }

  await client.end();
  console.log(count === 0
    ? 'Nothing to migrate — all up to date.'
    : `Applied ${count} migration(s).`);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
