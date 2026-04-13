import { createHash, randomBytes } from 'node:crypto';

const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOKEN_ID_LENGTH = 12;
const TOKEN_SECRET_LENGTH = 24;
const TOKEN_PREFIX = 'cc_live';
const INVITATION_PREFIX = 'cc_inv';

function randomTokenPart(length: number): string {
  const bytes = randomBytes(length);
  let output = '';

  for (let index = 0; index < length; index += 1) {
    output += TOKEN_ALPHABET[bytes[index]! % TOKEN_ALPHABET.length];
  }

  return output;
}

export function generateTokenId(): string {
  return randomTokenPart(TOKEN_ID_LENGTH);
}

export function generateTokenSecret(): string {
  return randomTokenPart(TOKEN_SECRET_LENGTH);
}

export function buildBearerToken(parts?: { tokenId?: string; secret?: string }): {
  tokenId: string;
  secret: string;
  bearerToken: string;
  tokenHash: string;
} {
  const tokenId = parts?.tokenId ?? generateTokenId();
  const secret = parts?.secret ?? generateTokenSecret();
  const bearerToken = `${TOKEN_PREFIX}_${tokenId}_${secret}`;

  return {
    tokenId,
    secret,
    bearerToken,
    tokenHash: hashTokenSecret(secret),
  };
}

export function buildInvitationCode(parts?: { tokenId?: string; secret?: string }): {
  tokenId: string;
  secret: string;
  invitationCode: string;
  tokenHash: string;
} {
  const tokenId = parts?.tokenId ?? generateTokenId();
  const secret = parts?.secret ?? generateTokenSecret();
  const invitationCode = `${INVITATION_PREFIX}_${tokenId}_${secret}`;

  return {
    tokenId,
    secret,
    invitationCode,
    tokenHash: hashTokenSecret(secret),
  };
}

export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function parseBearerToken(value: string): { tokenId: string; secret: string } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^cc_live_([23456789abcdefghjkmnpqrstuvwxyz]{12})_([23456789abcdefghjkmnpqrstuvwxyz]{24})$/);

  if (!match) {
    return null;
  }

  return {
    tokenId: match[1],
    secret: match[2],
  };
}

export function parseInvitationCode(value: string): { tokenId: string; secret: string } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^cc_inv_([23456789abcdefghjkmnpqrstuvwxyz]{12})_([23456789abcdefghjkmnpqrstuvwxyz]{24})$/);

  if (!match) {
    return null;
  }

  return {
    tokenId: match[1],
    secret: match[2],
  };
}
