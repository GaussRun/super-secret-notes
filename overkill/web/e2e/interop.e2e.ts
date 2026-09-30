// Same format, both directions: the CLI (node overkill/cli) and the web app share the fake
// hosts. A vault made by one is recovered by name + passphrase in the other, and read.
// Needs the CLI's dependencies installed (pnpm install in overkill/cli).
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startAllFakes, type Fakes } from './fakes';
import { useFakes, watchErrors, setupVault, putNote, recoverByName, readNote, nav } from './helpers';

const CLI = path.resolve('../cli/bin/super-secret-notes.js');
// six EFF list words: 77.5 bits, passes the CLI's and the web app's strength check
const CLI_PASSPHRASE = 'abacus zealous quilt mahogany ripcord unloved';

let fakes: Fakes;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

/** Backend configs for the CLI, named the way both clients name them. */
function cliBackends() {
	const n = (prefix: string, i: number) => `${prefix}-127${i ? `-${i + 1}` : ''}`;
	return [
		...fakes.hosts.privatebin.map((url, i) => ({ name: n('pb', i), type: 'privatebin', url })),
		...fakes.hosts.cryptpad.map((origin, i) => ({ name: n('cp', i), type: 'cryptpad', origin, derived: true })),
		...fakes.hosts.nostr.map((url, i) => ({ name: n('nostr', i), type: 'nostr', url })),
		...fakes.hosts.blossom.map((url, i) => ({ name: n('blossom', i), type: 'blossom', url }))
	];
}

async function cli(home: string, args: string[], env: Record<string, string> = {}) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			process.execPath,
			[CLI, '--home', home, ...args],
			{
				env: {
					PATH: process.env.PATH ?? '',
					HOME: home,
					NO_COLOR: '1',
					OVERKILL_DEFAULT_BACKENDS: JSON.stringify(cliBackends()),
					OVERKILL_DISCOVERY_RELAYS: fakes.hosts.discovery.join(','),
					OVERKILL_NOSTR_PAUSE_MS: '0',
					...env
				},
				timeout: 120_000
			},
			(err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
		);
	});
}

const home = () => mkdtemp(path.join(os.tmpdir(), 'ssn-interop-'));

test('CLI makes a vault and a note; the web app recovers it by name and reads it; the CLI reads the web note', async ({ browser }) => {
	const h = await home();
	const file = path.join(h, 'note.txt');
	await writeFile(file, 'from the command line\nsecond line');
	const put = await cli(h, ['put', 'cli note', file], { OVERKILL_PASSPHRASE: CLI_PASSPHRASE, OVERKILL_VAULT_NAME: 'interop from cli' });
	expect(put.code, put.stderr).toBe(0);
	expect(put.stdout).toMatch(/cli note: \d+ bytes, 6\/6 backends/);
	expect(put.stdout).toMatch(/recovery by name: bootstrap on 2\/2 relays/);

	const context = await browser.newContext();
	await useFakes(context, fakes);
	const page = await context.newPage();
	const errors = watchErrors(page);
	await recoverByName(page, 'interop from cli', CLI_PASSPHRASE);
	await expect(await readNote(page, 'cli note')).toHaveValue('from the command line\nsecond line');
	await nav(page, 'Check');
	await expect(page.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY');

	// and back: a note written in the browser, read by the CLI
	await putNote(page, 'web note', 'written in a browser tab');
	const get = await cli(h, ['get', 'web note'], { OVERKILL_PASSPHRASE: CLI_PASSPHRASE });
	expect(get.code, get.stderr).toBe(0);
	expect(get.stdout).toBe('written in a browser tab');
	const check = await cli(h, ['check'], { OVERKILL_PASSPHRASE: CLI_PASSPHRASE });
	expect(check.code, check.stdout + check.stderr).toBe(0);
	expect(errors).toEqual([]);
	await context.close();
});

test('the web app makes a vault and a note; the CLI recovers it by name and reads it', async ({ browser }) => {
	const context = await browser.newContext();
	await useFakes(context, fakes);
	const page = await context.newPage();
	const errors = watchErrors(page);
	const passphrase = await setupVault(page, 'interop from web');
	await putNote(page, 'Grüße', 'hello from the web app, with ümlauts');

	const h = await home();
	const rec = await cli(h, ['recover', '--name', 'interop from web'], { OVERKILL_PASSPHRASE: passphrase });
	expect(rec.code, rec.stderr).toBe(0);
	expect(rec.stdout).toContain('Found "interop from web"');
	const ls = await cli(h, ['ls'], { OVERKILL_PASSPHRASE: passphrase });
	expect(ls.stdout).toContain('Grüße');
	// the NFD spelling of the name finds the same note
	const get = await cli(h, ['get', 'Grüße'.normalize('NFD')], { OVERKILL_PASSPHRASE: passphrase });
	expect(get.code, get.stderr).toBe(0);
	expect(get.stdout).toBe('hello from the web app, with ümlauts');
	const check = await cli(h, ['check'], { OVERKILL_PASSPHRASE: passphrase });
	expect(check.code, check.stdout + check.stderr).toBe(0);
	expect(check.stdout).toContain('copies healthy');
	expect(errors).toEqual([]);
	await context.close();
});
