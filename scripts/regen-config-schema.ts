import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { configSchema } from '../src/config/schema.ts';

const schemaPath = new URL('../clawclub.config.schema.json', import.meta.url).pathname;
writeFileSync(schemaPath, JSON.stringify(z.toJSONSchema(configSchema), null, 2));
console.log(`Wrote ${schemaPath}`);
