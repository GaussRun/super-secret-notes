import { defineConfig } from '@playwright/test';

// One polite run against the REAL default hosts (not part of `pnpm test`):
//   OVERKILL_LIVE_SECRET_FILE=/path/outside/the/repo.json pnpm exec playwright test -c playwright.live.config.ts
// The production build (CSP: https: and wss: only), served at the root.
export default defineConfig({
	testDir: 'e2e-live',
	testMatch: '**/*.live.ts',
	timeout: 600_000,
	expect: { timeout: 120_000 },
	workers: 1,
	reporter: [['list']],
	use: { baseURL: 'http://127.0.0.1:4175', trace: 'off' },
	webServer: {
		command: 'pnpm build && node e2e/serve.mjs build "" 4175',
		url: 'http://127.0.0.1:4175/',
		timeout: 180_000,
		reuseExistingServer: false
	}
});
