// Browser stand-in for overkill/cli/src/log.js (winston). Same `logger` interface; messages go
// to the listeners (the activity log on the page) and debug lines to the console only.
const listeners = new Set();

/** fn({ level, message, at }) for every info, warn and error line; returns an unsubscribe. */
export function onLog(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function emit(level, message) {
	const line = { level, message: String(message), at: new Date().toISOString() };
	for (const fn of listeners) {
		try {
			fn(line);
		} catch {
			// a broken listener must not break the operation that logged
		}
	}
}

export const logger = {
	debug: (m) => console.debug(`overkill: ${m}`),
	info: (m) => emit('info', m),
	warn: (m) => emit('warn', m),
	error: (m) => emit('error', m)
};
