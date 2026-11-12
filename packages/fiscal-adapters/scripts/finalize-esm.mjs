import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Marca `dist/esm` como ESM.
 *
 * El paquete raiz es CommonJS (lo consume NestJS, que corre en Node sin ESM). Los
 * `.js` de `dist/esm` son ESM, asi que necesitan su propio `package.json` con
 * `type: module`: sin el, Node y Vite los interpretan como CJS y el tree shaking
 * deja de funcionar (y Rollup deja de poder leer los exports).
 *
 * Los imports relativos de `tsc` no llevan extension, que es lo que requiere
 * bundlers; por eso el ESM se emite solo para bundlers y el CJS para Node.
 */
const here = dirname(fileURLToPath(import.meta.url));
const esmDir = join(here, '..', 'dist', 'esm');

writeFileSync(join(esmDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

console.log('> dist/esm marcado como ESM');