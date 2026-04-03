/**
 * Application entry point — re-exports contract types and AppError.
 *
 * All action dispatch is handled by app-dispatch.ts via the schema registry.
 * This module exists as the stable import target for AppError and the
 * Repository/contract types used throughout the codebase.
 */

export * from './app-contract.ts';

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
