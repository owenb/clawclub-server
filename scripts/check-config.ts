import { ConfigError } from '../src/config/errors.ts';
import { getConfigFingerprint, loadConfigFromFile } from '../src/config/index.ts';

const explicitPath = process.argv[2] ?? null;

try {
  const config = loadConfigFromFile(explicitPath);
  const sourceLabel = explicitPath ?? process.env.CLAWCLUB_CONFIG_PATH ?? 'default-path-or-built-in-defaults';
  console.log(JSON.stringify({
    ok: true,
    source: sourceLabel,
    configFingerprint: getConfigFingerprint(config),
  }, null, 2));
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`${error.path}: ${error.message}`);
    for (const detail of error.details) {
      console.error(`- ${detail}`);
    }
    process.exit(1);
  }
  throw error;
}
