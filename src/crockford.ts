import { randomBytes } from 'node:crypto';

export const CROCKFORD_LOWER_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function randomCrockfordString(length: number): string {
  const bytes = randomBytes(length);
  let output = '';

  for (let index = 0; index < length; index += 1) {
    output += CROCKFORD_LOWER_ALPHABET[bytes[index]! % CROCKFORD_LOWER_ALPHABET.length];
  }

  return output;
}

