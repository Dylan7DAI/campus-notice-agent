import js from '@eslint/js';
export default [js.configs.recommended, { ignores: ['.next/**', 'scripts/**', 'evals/runs/**', 'test-results/**', 'playwright-report/**'] }];
