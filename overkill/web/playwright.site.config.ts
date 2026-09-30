import { defineConfig } from '@playwright/test';

// The end-to-end run against a DEPLOYED site and the REAL hosts (not part of `pnpm test`):
//   OVERKILL_SITE=https://gaussrun.github.io/super-secret-notes pnpm exec playwright test -c playwright.site.config.ts
// One throwaway vault per run (a new random name; at most one new CryptPad account), polite
// pacing, a per-step PASS/FAIL table at the end. The passphrase is never printed.
export default defineConfig({
	testDir: 'e2e-live',
	testMatch: '**/*.site.ts',
	timeout: 1_800_000,
	expect: { timeout: 120_000 },
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: { trace: 'off', acceptDownloads: true }
});
