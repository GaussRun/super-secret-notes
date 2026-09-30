// Browser stand-in for overkill/cli/src/vaultsecrets.js: the same store and locator logic
// (vaultsecrets-core.js), without the file fallbacks and migrations of the CLI state directory.
import { storeLocatorState } from '$cli/vaultsecrets-core.js';

export * from '$cli/vaultsecrets-core.js';

/** Paste-like backends keep their locators in secrets.ovk; the web client always has a store. */
export function locatorState(ctx, name) {
	if (!ctx.secrets) throw new Error(`${name}: no secret store to keep locators in`);
	return storeLocatorState(ctx.secrets, name);
}
