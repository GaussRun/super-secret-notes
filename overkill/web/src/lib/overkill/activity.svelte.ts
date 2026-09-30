// The live log on the page: every line the CLI modules log (uploads, retries, warnings) plus the
// steps the web client announces. Never holds secrets; the CLI modules do not log any.
import { onLog } from './shims/log.js';

export interface Line {
	level: 'step' | 'ok' | 'info' | 'warn' | 'error';
	message: string;
	at: string;
}

class Activity {
	lines = $state<Line[]>([]);

	constructor() {
		onLog((l: { level: Line['level']; message: string; at: string }) => this.lines.push(l));
	}

	clear() {
		this.lines = [];
	}

	say(message: string, level: Line['level'] = 'step') {
		this.lines.push({ level, message, at: new Date().toISOString() });
	}

	/** Announce a step, run it, mark it done (or failed, and rethrow). */
	async step<T>(message: string, fn: () => Promise<T>, done?: (v: T) => string): Promise<T> {
		this.say(message);
		try {
			const v = await fn();
			this.say(done ? done(v) : `${message}: done`, 'ok');
			return v;
		} catch (err) {
			this.say(`${message}: ${(err as Error).message}`, 'error');
			throw err;
		}
	}
}

export const activity = new Activity();
