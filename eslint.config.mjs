import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Configuracion de ESLint (flat config, ESLint 9).
 *
 * Tres decisiones:
 *
 *  1. **El lint no reemplaza al typecheck.** TypeScript estricto ya atrapa la
 *     mayoria de los errores; ESLint aca busca lo que el compilador no ve:
 *     Promesas sin `await`, `any` implicito, imports muertos.
 *
 *  2. **Las reglas que se activan con `typeCheck` corren sobre el programa.**
 *     `projectService` (no `project`) evita tener que mantener una lista de
 *     `tsconfig.json` que se desincroniza con cada paquete nuevo.
 *
 *  3. **`prettier` va ultimo y desactiva el formateo.** Prettier ya corre por
 *     separado en `format:check`; que los dos peleen por el mismo archivo
 *     produce conflictos que se resuelven a favor del que gana, no del que
 *     conviene.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/*.tsbuildinfo',
      '**/drizzle/meta/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Todo el codigo del repo, en una sola capa de reglas.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        // `projectService` resuelve el `tsconfig.json` mas cercano de cada
        // archivo, asi que agregar un paquete no obliga a tocar esta lista.
        // Sin esto, las reglas que necesitan tipos (floating promises, etc.)
        // no corren: el parser no tiene de que inferirlos.
        projectService: {
          allowDefaultProject: ['*.config.ts', '*.config.mts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // ElDominio usa `unknown` + Zod en los bordes; `any` es una puerta a que
      // un payload sin validar termine tocandose money como si fuera numero.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Los imports de tipo se cuentan como "usados" si el compilador los ve.
          // Esto cubre `import type { X }` que solo aparece en firmas.
          caughtErrors: 'none',
        },
      ],
      // Promesa sin await ni catch: casi siempre una operacion de negocio que
      // nadie va a notar si falla. En el POS, donde todo es optimista, esto es
      // exactamente el bug que hace perder una comanda en silencio.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'log'] }],
    },
  },

  {
    // Archivos de configuracion y CLI: corren por Node, no en el navegador, y
    // necesitan variables de proceso y `__dirname`.
    files: ['**/*.config.{ts,tsx}', '**/scripts/**/*.ts', 'apps/api/src/database/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // Los tests declaran fixtures, mocks y casos que el codigo de produccion no
    // tendria:Accessos largos a `any` y `!` sobre fixtures son aceptables.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  prettier,
);