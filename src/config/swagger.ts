
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const openApiPath = resolve(
    process.cwd(),
    'docs',
    'openapi.yaml',
);

const openApiDocument = parse(
    readFileSync(openApiPath, 'utf8'),
);

export { swaggerUi, openApiDocument };
