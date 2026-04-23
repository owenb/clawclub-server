import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashProducerSecret(secret: string): string {
  return hashText(secret.trim());
}

export function verifyProducerSecret(secret: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash) {
    return false;
  }

  const actual = Buffer.from(hashProducerSecret(secret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function generateProducerSecret(): string {
  return randomBytes(24).toString('base64url');
}
