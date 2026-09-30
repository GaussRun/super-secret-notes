import { defineConfig } from '@playwright/test';

// The built static site (test build: base path /ovk-test, CSP allowing the loopback fakes),
// served like GitHub Pages would serve it. The fake hosts run inside the test process.
export const BASE = '/ovk-test';
// several checkouts may run the suite at once: OVERKILL_E2E_PORT picks another port
export const PORT = Number(process.env.OVERKILL_E2E_PORT ?? 4173);
export const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	timeout: 180_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: { baseURL: ORIGIN, trace: 'off' },
	webServer: {
		command: `pnpm build:test && node e2e/serve.mjs build-test ${BASE} ${PORT}`,
		url: `${ORIGIN}${BASE}/`,
		timeout: 180_000,
		reuseExistingServer: false
	}
});
