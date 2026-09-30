// Who makes this possible: the projects we build on and the people who run the default hosts.
// Every link was checked (HTTP 200, 2026-09-30); `support` only where the operator or project has
// a donation or sponsorship page of its own.

export interface Credit {
	name: string;
	url: string;
	what: string;
	support?: string;
}

export const PROJECTS: Credit[] = [
	{ name: 'PrivateBin', url: 'https://privatebin.info/', what: 'the zero-knowledge pastebin behind three of the default hosts (code: github.com/PrivateBin/PrivateBin)' },
	{ name: 'CryptPad', url: 'https://cryptpad.org/', what: 'the end-to-end encrypted office suite, made by the CryptPad team at XWiki SAS', support: 'https://opencollective.com/cryptpad' },
	{ name: 'Nostr', url: 'https://nostr.com/', what: 'the relay protocol; its specifications are the NIPs (github.com/nostr-protocol/nips)' },
	{ name: 'Blossom', url: 'https://github.com/hzrd149/blossom', what: 'the blob-server specification by hzrd149' },
	{ name: 'age and typage', url: 'https://github.com/FiloSottile/age', what: 'the file encryption format and the TypeScript implementation we use (github.com/FiloSottile/typage), by Filippo Valsorda', support: 'https://github.com/sponsors/FiloSottile' }
];

export const OPERATORS: { kind: string; hosts: Credit[] }[] = [
	{
		kind: 'PrivateBin instances',
		hosts: [
			{ name: 'pb.envs.net', url: 'https://pb.envs.net', what: 'run by envs.net', support: 'https://envs.net/donate/' },
			{ name: 'paste.systemli.org', url: 'https://paste.systemli.org', what: 'run by systemli.org (www.systemli.org)' },
			{ name: 'extrait.facil.services', url: 'https://extrait.facil.services', what: 'run by FACIL (facil.services)', support: 'https://facil.qc.ca/civicrm/contribute/transact?reset=1&id=2' }
		]
	},
	{
		kind: 'CryptPad instances',
		hosts: [
			{ name: 'cryptpad.private.coffee', url: 'https://cryptpad.private.coffee', what: 'run by private.coffee' },
			{ name: 'crypt.unredacted.org', url: 'https://crypt.unredacted.org', what: 'run by Unredacted (used by the command line tool)', support: 'https://unredacted.org/donate/' }
		]
	},
	{
		kind: 'Nostr relays',
		hosts: [
			{ name: 'nos.lol', url: 'https://nos.lol', what: 'public relay' },
			{ name: 'nostr.mom', url: 'https://nostr.mom', what: 'public relay' },
			{ name: 'purplerelay.com', url: 'https://purplerelay.com', what: 'public relay' },
			{ name: 'nostr.oxtr.dev', url: 'https://nostr.oxtr.dev', what: 'public relay' }
		]
	},
	{
		kind: 'Blossom servers',
		hosts: [
			{ name: 'nostr.download', url: 'https://nostr.download', what: 'public blob server' },
			{ name: 'blossom.ditto.pub', url: 'https://blossom.ditto.pub', what: 'run by Ditto (ditto.pub)' },
			{ name: 'cdn.hzrd149.com', url: 'https://cdn.hzrd149.com', what: 'run by hzrd149, who also wrote the Blossom specification' }
		]
	}
];
