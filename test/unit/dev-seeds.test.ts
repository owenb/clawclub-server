import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('dev seeds insert email on seeded members and no longer rely on onboarded_at', () => {
  const sql = readFileSync(resolve(process.cwd(), 'db/seeds/dev.sql'), 'utf8');
  assert.match(
    sql,
    /insert into members \(public_name, display_name, state, email, created_at\) values/i,
  );
  assert.doesNotMatch(sql, /member_private_contacts/i);
  assert.doesNotMatch(sql, /onboarded_at/i);
});
