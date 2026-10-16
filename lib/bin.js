#!/usr/bin/env node
import { D as CN_VARIANT, O as WORKBUDDY_VARIANTS, P as WorkBuddyUpstreamClient, T as atRestKeyProviderFor, a as readHostHeartbeat, c as WORKBUDDY_CONNECT_VERSION, d as WorkBuddyQuotaStore, f as quotaAccountOf, h as FALLBACK_WORKBUDDY_MODELS, it as resolveAppVersion, k as variantFor, l as WorkBuddyQuotaCheckStore, m as FALLBACK_WORKBUDDY_AI_MODELS, o as workbuddyHostHeartbeatPath, p as workbuddyQuotaPath, r as isHeartbeatProcessAlive, st as WorkBuddyAccountStore, u as workbuddyQuotaCheckPath, y as WorkBuddyCredentialStore } from "./host-heartbeat-BnPyEVGj.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-connect <doctor|status|logout|accounts> [options]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)",
		"  accounts manage parked accounts and switch between them:",
		"             accounts list                      parked accounts, * marks the active one",
		"             accounts quota                     the last quota check, per account",
		"             accounts add [--label <name>]      archive the account the app is signed into",
		"             accounts use <id>                  serve that account from now on",
		"             accounts rename <id> [--label <name>]",
		"             accounts remove <id>",
		"",
		"  --provider  which product to inspect; defaults to workbuddy",
		`              one of: ${WORKBUDDY_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --label     display name for accounts add / rename",
		"  --json      emit one secret-free JSON document (all commands except logout)",
		"",
		"  Sign in to each account in the desktop app and run `accounts add` once per",
		"  account; slots live under $DSH_HOME and the app's own auth file is never written.",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/**
* One variant's store plus the client that performs its refreshes.
*
* The key provider is built by the same shared helper the plugin host uses,
* so the CLI's `doctor`/`status` and the browser card can never disagree
* about which product's Electron a variant resolves.
*/
function makeStore(variant) {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({
		variant,
		refresh: (credential) => client.refreshToken(credential),
		keyProvider: atRestKeyProviderFor(variant)
	});
}
/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant) {
	return makeStore(variant).ownAuthPath();
}
/** Fallback roster size for one variant. */
function fallbackCount(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length;
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const desktopFormat = await store.desktopAuthFormat();
	const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const appVersion = variant.region === "global" ? await resolveAppVersion() : void 0;
	const decryptionNote = status.state === "signed-out" && desktopFormat === "encrypted" && status.reason !== void 0 ? `Encrypted desktop credential could not be used: ${status.reason}` : void 0;
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-connect",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		desktopAuthFile: {
			path: desktopPath ?? `(no platform default; set ${variant.env})`,
			present: desktopPresent,
			format: desktopFormat
		},
		ownAuthFile: ownAuthPath(variant),
		...appVersion === void 0 ? {} : { catalogUserAgent: {
			version: appVersion.version,
			source: appVersion.source,
			...appVersion.bundle === void 0 ? {} : { bundle: appVersion.bundle }
		} },
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		fallbackModels: fallbackCount(variant),
		hints: [
			...decryptionNote !== void 0 ? [decryptionNote] : status.state === "signed-out" ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
			...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson({
		...report,
		...decryptionNote === void 0 ? {} : { decryptionNote }
	});
	else process.stdout.write([
		`${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} — ${desktopFormat} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...appVersion === void 0 ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && desktopPresent ? 0 : 1;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") {
		if (jsonOutput) printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-out",
			hostBundle: hostState
		});
		else process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`);
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) {
			const fetched = await client.fetchCredits(credential);
			credits = {
				total: fetched.total,
				...fetched.unlimited === true ? { unlimited: true } : {}
			};
		}
	} catch (error) {
		credits = {
			total: 0,
			error: safeMessage(error)
		};
	}
	const expiresAt = authStatus.expiresAtMs !== void 0 ? new Date(authStatus.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.unlimited === true ? { creditsUnlimited: true } : {},
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState
		});
		return 0;
	}
	process.stdout.write([
		`${variant.displayName} Connect: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error !== void 0 ? `Remaining credit: unavailable (${credits.error})` : credits?.unlimited === true ? "Remaining credit: unlimited" : `Remaining credit: ${credits?.total ?? "unknown"}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
/** Render slots plus the active pointer for `accounts list --json`. */
async function accountRows(store, quota) {
	const activeId = await store.activeId();
	return {
		rows: (await store.summaries()).map((summary) => {
			const status = quota.status(quotaAccountOf(summary));
			const exhausted = status.state === "exhausted";
			return {
				id: summary.id,
				...summary.label === void 0 ? {} : { label: summary.label },
				...summary.nickname === void 0 ? {} : { nickname: summary.nickname },
				uid: summary.uid,
				domain: summary.domain,
				expiresAt: new Date(summary.expiresAtMs).toISOString(),
				active: summary.active,
				expired: summary.expired,
				quota: exhausted ? "exhausted" : "ok",
				...status.exhaustedAtMs === void 0 ? {} : { exhaustedAt: new Date(status.exhaustedAtMs).toISOString() }
			};
		}),
		...activeId === void 0 ? {} : { activeId }
	};
}
/** Human-readable label for one slot. */
function rowLabel(row) {
	const name = row.label ?? row.nickname;
	return name === void 0 ? row.id : `${name} (${row.id})`;
}
/** One quota-check row as the terminal states it. */
function quotaRow(result) {
	if (result.state === "available") return `available (http ${String(result.status)})`;
	if (result.state === "exhausted") return `QUOTA USED UP (http ${String(result.status)})`;
	return `unknown${result.reason === void 0 ? "" : `: ${result.reason}`} (http ${String(result.status)})`;
}
/**
* `quota` — the last on-demand quota check for this variant's parked accounts.
*
* Read-only on purpose: the sweep spends one real request per parked account,
* so it belongs behind the card's explicit button rather than behind a command
* a user may run twice out of curiosity. This reports what that button paid for.
*/
async function quotaCheck(jsonOutput, variant, store) {
	const checks = new WorkBuddyQuotaCheckStore(workbuddyQuotaCheckPath(variant.quotaCheckFilename));
	const sweep = checks.last();
	const activeId = await store.activeId();
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			file: checks.filePath(),
			checked: sweep !== void 0,
			...sweep === void 0 ? {} : {
				model: sweep.model,
				checkedAt: new Date(sweep.checkedAtMs).toISOString(),
				results: sweep.results.map((result) => ({
					id: result.id,
					...result.label === void 0 ? {} : { label: result.label },
					active: result.id === activeId,
					state: result.state,
					status: result.status,
					...result.reason === void 0 ? {} : { reason: result.reason }
				}))
			}
		});
		return 0;
	}
	if (sweep === void 0) {
		process.stdout.write([
			`${variant.displayName}: no quota check on record`,
			"Start one from the plugin card — it sends one minimal request per parked",
			`account and writes the answer to ${checks.filePath()}.`,
			""
		].join("\n"));
		return 0;
	}
	process.stdout.write([
		`${variant.displayName} quota check — ${sweep.model}, ${new Date(sweep.checkedAtMs).toISOString()}:`,
		...sweep.results.length === 0 ? ["  (no parked account was recorded for this check)"] : sweep.results.map((result) => `  ${result.id === activeId ? "*" : " "} ${result.label ?? result.id} — ${quotaRow(result)}`),
		"",
		"(* = currently served)",
		...sweep.results.some((result) => result.state === "exhausted") ? ["QUOTA USED UP = the upstream refused a minimal request for insufficient credit; switch accounts."] : [],
		...sweep.results.some((result) => result.state === "unknown") ? ["unknown = the check could not decide (transport failure, sign-in, rate limit). Not a spent account."] : [],
		"A check is one moment: an account reported available can still run dry before the next message.",
		""
	].join("\n"));
	return 0;
}
/**
* `accounts` — manage parked accounts for one variant.
*
* `add` archives whatever the desktop app is signed into right now, which is
* the only way to capture an account whose sign-in the app owns: sign in, run
* `add`, repeat. `use` moves the pointer the running plugin resolves against,
* so a switch needs no restart.
*/
async function accounts(jsonOutput, variant, command, operands, label) {
	const store = new WorkBuddyAccountStore({ variant });
	const quota = new WorkBuddyQuotaStore(workbuddyQuotaPath(variant.quotaFilename));
	if (command === void 0 || command === "list") {
		const { rows, activeId } = await accountRows(store, quota);
		if (jsonOutput) {
			printJson({
				schemaVersion: JSON_SCHEMA_VERSION,
				package: "dsh-workbuddy-connect",
				version: WORKBUDDY_CONNECT_VERSION,
				provider: variant.id,
				directory: store.directory(),
				...activeId === void 0 ? {} : { activeId },
				accounts: rows
			});
			return 0;
		}
		if (rows.length === 0) {
			process.stdout.write([
				`${variant.displayName}: no stored accounts`,
				`Add one after signing in: dsh-workbuddy-connect accounts add [--label <name>] --provider ${variant.id}`,
				""
			].join("\n"));
			return 0;
		}
		process.stdout.write([
			`${variant.displayName} accounts (${rows.length}):`,
			...rows.map((row) => `  ${row.active ? "*" : " "} ${rowLabel(row)}${row.nickname === void 0 || row.label === void 0 ? "" : ` as ${row.nickname}`} — token ${row.expired ? "expired" : `expires ${row.expiresAt}`}${row.quota === "exhausted" ? ` — QUOTA EXHAUSTED${row.exhaustedAt === void 0 ? "" : ` since ${row.exhaustedAt}`}` : ""}`),
			"",
			"(* = currently served; switch with: accounts use <id>)",
			...rows.some((row) => row.quota === "exhausted") ? ["", "QUOTA EXHAUSTED = the upstream refused this account for insufficient credit; switch to another one."] : [],
			""
		].join("\n"));
		return 0;
	}
	if (command === "quota") return await quotaCheck(jsonOutput, variant, store);
	if (command === "add") {
		const credential = await makeStore(variant).desktopCredential();
		if (credential === void 0) {
			process.stderr.write(`dsh-workbuddy-connect: no signed-in ${variant.appName} account found; sign in once in the desktop app, then run accounts add again
`);
			return 1;
		}
		const slot = await store.save(credential, label === void 0 ? {} : { label });
		if (jsonOutput) {
			printJson({
				schemaVersion: JSON_SCHEMA_VERSION,
				package: "dsh-workbuddy-connect",
				version: WORKBUDDY_CONNECT_VERSION,
				provider: variant.id,
				added: {
					id: slot.id,
					...slot.label === void 0 ? {} : { label: slot.label },
					uid: slot.credential.uid
				},
				activeId: slot.id
			});
			return 0;
		}
		process.stdout.write([`${variant.displayName}: stored ${rowLabel({
			id: slot.id,
			...slot.label === void 0 ? {} : { label: slot.label },
			...slot.credential.nickname === void 0 ? {} : { nickname: slot.credential.nickname },
			uid: slot.credential.uid,
			domain: slot.credential.domain,
			expiresAt: new Date(slot.credential.expiresAtMs).toISOString(),
			active: true,
			expired: false,
			quota: quota.status(quotaAccountOf(slot.credential)).state === "exhausted" ? "exhausted" : "ok"
		})} and selected it`, ""].join("\n"));
		return 0;
	}
	if (command === "use") {
		const id = operands[0];
		if (id === void 0) {
			process.stderr.write("dsh-workbuddy-connect: accounts use needs an account id (see accounts list)\n");
			return 1;
		}
		await store.setActive(id);
		const { rows, activeId } = await accountRows(store, quota);
		if (jsonOutput) {
			printJson({
				schemaVersion: JSON_SCHEMA_VERSION,
				package: "dsh-workbuddy-connect",
				version: WORKBUDDY_CONNECT_VERSION,
				provider: variant.id,
				...activeId === void 0 ? {} : { activeId },
				accounts: rows
			});
			return 0;
		}
		const active = rows.find((row) => row.active);
		process.stdout.write(`${variant.displayName}: now serving ${active === void 0 ? id : rowLabel(active)}; the running plugin picks this up on its next request
`);
		return 0;
	}
	if (command === "rename") {
		const id = operands[0];
		if (id === void 0) {
			process.stderr.write("dsh-workbuddy-connect: accounts rename needs an account id and an optional label\n");
			return 1;
		}
		const slot = await store.relabel(id, label);
		process.stdout.write(`${variant.displayName}: ${slot.id} is now ${slot.label ?? "(unnamed)"}\n`);
		return 0;
	}
	if (command === "remove") {
		const id = operands[0];
		if (id === void 0) {
			process.stderr.write("dsh-workbuddy-connect: accounts remove needs an account id (see accounts list)\n");
			return 1;
		}
		await store.remove(id);
		const stillSelected = await store.isEnabled();
		process.stdout.write([
			`${variant.displayName}: removed ${id}`,
			...stillSelected ? [] : ["No account is selected now, so the plugin follows the desktop app again."],
			""
		].join("\n"));
		return 0;
	}
	process.stderr.write(`dsh-workbuddy-connect: unknown accounts command ${JSON.stringify(command)}; expected add, list, quota, remove, rename, or use
`);
	return 1;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"accounts",
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy-connect: expected accounts, doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	let label;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		if (flag === "--label") {
			label = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--label=")) {
			label = flag.slice(8);
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CN_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	const positional = rest.filter((flag) => !flag.startsWith("--"));
	if (rest.filter((flag) => flag.startsWith("--") && flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "accounts": {
				const [command, ...operands] = positional;
				return await accounts(jsonOutput, variant, command, operands, label);
			}
			case "doctor": return await doctor(jsonOutput, variant);
			case "status": return await status(jsonOutput, variant);
			case "logout": {
				const store = makeStore(variant);
				await store.logout();
				process.stdout.write(`${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
