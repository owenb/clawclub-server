import { ZodError } from 'zod';

export class ConfigError extends Error {
  readonly path: string;
  readonly details: string[];

  constructor(path: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
    this.details = details;
  }
}

export function formatConfigError(error: ConfigError): string {
  const header = `${error.message} at ${error.path}`;
  if (error.details.length === 0) {
    return header;
  }
  return `${header}\n${error.details.map((detail) => `- ${detail}`).join('\n')}`;
}

export function zodIssuesToConfigDetails(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
