export const EMAIL_ALREADY_REGISTERED_MESSAGE = 'That email is already registered to another member.';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isMembersEmailUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'members_email_unique'
  );
}
