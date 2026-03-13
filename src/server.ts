import http from 'node:http';
import { URL } from 'node:url';
import { Pool } from 'pg';
import { AppError, buildApp, type DeliverySecretResolver, type Repository } from './app.ts';
import { createDeliverySecretResolver } from './delivery-signing.ts';
import { createPostgresRepository } from './postgres.ts';

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';

    request.setEncoding('utf8');

    request.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new AppError(413, 'payload_too_large', 'Request body exceeded 1MB'));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (body.trim().length === 0) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(body);

        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          reject(new AppError(400, 'invalid_json', 'Request body must be a JSON object'));
          return;
        }

        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new AppError(400, 'invalid_json', 'Request body must be valid JSON'));
      }
    });

    request.on('error', reject);
  });
}

function getBearerToken(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization;

  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload, null, 2));
}

export function createServer(options: { resolveDeliverySecret?: DeliverySecretResolver; repository?: Repository } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  const pool = options.repository ? null : new Pool({ connectionString: databaseUrl ?? (() => { throw new Error('DATABASE_URL must be set'); })() });
  const repository = options.repository ?? createPostgresRepository({ pool: pool! });
  const app = buildApp({ repository, resolveDeliverySecret: options.resolveDeliverySecret ?? createDeliverySecretResolver() });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'POST' || url.pathname !== '/api') {
      writeJson(response, 404, {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Only POST /api is supported',
        },
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await app.handleAction({
        bearerToken: getBearerToken(request),
        action: body.action,
        payload: body.input,
      });

      writeJson(response, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      if (error instanceof AppError) {
        writeJson(response, error.statusCode, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      console.error(error);
      writeJson(response, 500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Unexpected server error',
        },
      });
    }
  });

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (pool) {
      await pool.end();
    }
  };

  return { server, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, shutdown } = createServer();
  const port = Number(process.env.PORT ?? 8787);

  server.listen(port, () => {
    console.log(`clawclub api listening on http://127.0.0.1:${port}/api`);
    console.log('auth mode: hashed API-style bearer tokens in app.member_bearer_tokens');
  });

  const stop = async () => {
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
