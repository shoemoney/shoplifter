import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'public', '.remember'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Simulation must be deterministic — use core/rng.ts (Rng) instead.',
        },
      ],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.test.ts', 'e2e/**/*.ts', '*.config.ts', 'eslint.config.js'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
