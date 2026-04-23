export function assertStartupConfig(input: {
  entrypoint: string;
  requiredDatabaseEnv?: string | null;
  required?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? process.env;
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const required = [
    ...(input.requiredDatabaseEnv === null ? [] : [input.requiredDatabaseEnv ?? 'DATABASE_URL']),
    ...(input.required ?? []),
  ];
  const missing = required.filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `[${input.entrypoint}] missing required production environment variables: ${missing.join(', ')}`,
    );
  }
}
