import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER = 'x-clawclub-signature-timestamp';
export const CLAWCLUB_SIGNATURE_V1_HEADER = 'x-clawclub-signature-v1';
const DEFAULT_TOLERANCE_SECONDS = 300;

export type ClawClubSignatureHeaders = {
  [CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER]: string;
  [CLAWCLUB_SIGNATURE_V1_HEADER]: string;
};

export function signClawClubDelivery(input: { secret: string; body: string; timestamp?: string }): ClawClubSignatureHeaders {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const signature = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest('hex');

  return {
    [CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER]: timestamp,
    [CLAWCLUB_SIGNATURE_V1_HEADER]: `sha256=${signature}`,
  };
}

function parseHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClawClubSignatureHeaders(headers: Record<string, string | string[] | undefined>) {
  return {
    timestamp: parseHeaderValue(headers[CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER]),
    signature: parseHeaderValue(headers[CLAWCLUB_SIGNATURE_V1_HEADER]),
  };
}

export function verifyClawClubDeliverySignature(input: {
  secret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'invalid_timestamp' | 'timestamp_out_of_range' | 'invalid_signature_format' | 'signature_mismatch' } {
  if (!input.timestamp || !input.signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Date.parse(input.timestamp);
  if (Number.isNaN(timestampMs)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const match = input.signature.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) {
    return { ok: false, reason: 'invalid_signature_format' };
  }

  const expected = createHmac('sha256', input.secret).update(`${input.timestamp}.${input.body}`).digest();
  const actual = Buffer.from(match[1], 'hex');

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

export type DeliverySecretResolutionInput = { sharedSecretRef: string };
export type DeliverySecretResolverFn = (input: DeliverySecretResolutionInput) => Promise<string | null>;

export function createDeliverySecretResolver(options: {
  env?: NodeJS.ProcessEnv;
  readOpSecret?: (ref: string) => Promise<string | null>;
} = {}): DeliverySecretResolverFn {
  const env = options.env ?? process.env;
  const readOpSecret = options.readOpSecret ?? defaultOpSecretReader;

  return async ({ sharedSecretRef }) => {
    const ref = sharedSecretRef.trim();
    if (ref.length === 0) {
      return null;
    }

    if (ref.startsWith('env:')) {
      const envName = ref.slice(4).trim();
      return envName.length > 0 ? env[envName] ?? null : null;
    }

    if (ref.startsWith('op://')) {
      return readOpSecret(ref);
    }

    return null;
  };
}

async function defaultOpSecretReader(ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('op', ['read', ref], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
