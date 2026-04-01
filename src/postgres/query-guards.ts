import { AppError } from '../app.ts';

export function requireReturnedRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new AppError(500, 'missing_row', message);
  }

  return row;
}
