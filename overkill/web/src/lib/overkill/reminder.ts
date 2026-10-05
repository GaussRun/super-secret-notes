// "Check your vault every 3 months" as a calendar file (iCalendar, RFC 5545), made in the page.
// It holds the vault link (the name only), never the passphrase.

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** Content lines are folded at 75 octets (RFC 5545 3.1); our lines are ASCII after escaping. */
function fold(line: string) {
	const out: string[] = [];
	for (let i = 0; i < line.length; i += 74) out.push((i ? ' ' : '') + line.slice(i, i + 74));
	return out.join('\r\n');
}

/** A quarterly all-day event, first in 3 months, with the vault link. */
export function reminderIcs(vaultName: string, vaultLink: string, now = new Date()) {
	const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, now.getUTCDate()));
	const uid = `${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}@super-secret-notes`;
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Super Secret Notes//Check reminder//EN',
		'CALSCALE:GREGORIAN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		`DTSTAMP:${stamp(now)}`,
		`DTSTART;VALUE=DATE:${day(first)}`,
		'RRULE:FREQ=MONTHLY;INTERVAL=3',
		`SUMMARY:${esc(`Check your vault "${vaultName}" (Super Secret Notes)`)}`,
		`DESCRIPTION:${esc(`Open ${vaultLink} , enter your passphrase and run "Check copies" (it also restores missing copies). This reminder holds no passphrase.`)}`,
		`URL:${vaultLink}`,
		'END:VEVENT',
		'END:VCALENDAR'
	];
	return lines.map(fold).join('\r\n') + '\r\n';
}
