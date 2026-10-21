import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/build/**',
      '.yarn/**',
      'apps/example/ios/**',
      'apps/example/android/**',
      'apps/example/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Fiber internals are untyped; `any` is confined to the inspector with local disables.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off',
      // Patched console/XHR/Alert functions need both the caller's `this` and the collector.
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['collector', 'tracker'] }],
    },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly', setTimeout: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { files: ['**/*.mjs', 'eslint.config.mjs'], languageOptions: { sourceType: 'module' } },
);
