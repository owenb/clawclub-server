import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('dev seeds insert onboarded_at for seeded members', () => {
  const sql = readFileSync(resolve(process.cwd(), 'db/seeds/dev.sql'), 'utf8');
  assert.match(
    sql,
    /insert into members \(public_name, display_name, state, onboarded_at, created_at\) values/i,
  );
});
