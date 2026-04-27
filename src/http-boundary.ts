import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { AppError } from './errors.ts';
import { DEFAULT_SERVER_LIMITS } from './config/defaults.ts';
import { canonicalizeTimestampFields } from './timestamps.ts';

type JsonWriteOptions = {
  extraHeaders?: Record<string, string>;
  destroySocketAfterResponse?: boolean;
  onNon2xx?: (statusCode: number, payload: unknown, bytes: number) => void;
};

type StaticCacheEntry = {
  body: Buffer;
  gzip: Buffer;
};

const staticResponseCache = new Map<string, StaticCacheEntry>();

export function parseBearerAuthorization(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    throw new AppError('invalid_auth_header', 'Authorization must use Bearer <token>');
  }
  return match[1];
}

export function getBearerToken(request: http.IncomingMessage): string | null {
  return parseBearerAuthorization(request.headers.authorization);
}

export function readJsonBody(
  request: http.IncomingMessage,
  maxBodyBytes = DEFAULT_SERVER_LIMITS.maxBodyBytes,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };

    const resolveOnce = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;

      if (totalBytes > maxBodyBytes) {
        request.pause();
        rejectOnce(new AppError('payload_too_large', 'Request body exceeded 1MB', { closeConnection: true }));
        request.resume();
        return;
      }

      chunks.push(buffer);
    };

    const onEnd = () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.trim().length === 0) {
        resolveOnce({});
        return;
      }

      try {
        const parsed = JSON.parse(body);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          rejectOnce(new AppError('invalid_json', 'Request body must be a JSON object'));
          return;
        }
        resolveOnce(parsed as Record<string, unknown>);
      } catch {
        rejectOnce(new AppError('invalid_json', 'Request body must be valid JSON'));
      }
    };

    const onError = (error: Error) => rejectOnce(error);
    const onAborted = () => rejectOnce(new Error('Request body was aborted'));

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

export function writeCompressed(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders?: Record<string, string>,
  onEnd?: () => void,
) {
  const accept = String(request.headers['accept-encoding'] ?? '');
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };

  if (/\bgzip\b/.test(accept)) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
    response.writeHead(statusCode, headers);
    response.end(gzipSync(Buffer.from(body, 'utf-8')), onEnd);
    return;
  }

  response.writeHead(statusCode, headers);
  response.end(body, onEnd);
}

export function writeCachedText(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  cacheKey: string,
  bodyFactory: () => string,
  extraHeaders?: Record<string, string>,
) {
  const accept = String(request.headers['accept-encoding'] ?? '');
  let entry = staticResponseCache.get(cacheKey);
  if (!entry) {
    const body = Buffer.from(bodyFactory(), 'utf-8');
    entry = { body, gzip: gzipSync(body) };
    staticResponseCache.set(cacheKey, entry);
  }

  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };
  if (/\bgzip\b/.test(accept)) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
    response.writeHead(statusCode, headers);
    response.end(entry.gzip);
    return;
  }
  response.writeHead(statusCode, headers);
  response.end(entry.body);
}

export function writeJson(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  options: JsonWriteOptions = {},
) {
  const body = JSON.stringify(canonicalizeTimestampFields(payload));
  writeCompressed(request, response, statusCode, 'application/json; charset=utf-8', body, {
    'cache-control': 'no-store, no-cache, max-age=0',
    pragma: 'no-cache',
    ...(options.extraHeaders ?? {}),
  }, options.destroySocketAfterResponse ? () => {
    request.socket.destroy();
  } : undefined);
  if (statusCode >= 400) {
    options.onNon2xx?.(statusCode, payload, body.length);
  }
}

export function writeSuccessEnvelope(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  data: unknown,
  options?: JsonWriteOptions,
) {
  writeJson(request, response, 200, { ok: true, data }, options);
}

export function writeErrorEnvelope(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  statusCode: number,
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestTemplate?: unknown;
  },
  options?: JsonWriteOptions,
) {
  writeJson(request, response, statusCode, {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.requestTemplate !== undefined ? { requestTemplate: error.requestTemplate } : {}),
    },
  }, options);
}
