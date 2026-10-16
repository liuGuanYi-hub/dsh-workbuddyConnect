# DSH WorkBuddy Connect

English | [中文](./README.md)

Brings the models available in your signed-in WorkBuddy / WorkBuddy AI desktop app into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); the two versions each show their own model group and reuse their own account sign-in and credit.

## Install

**Prerequisite**: the WorkBuddy (CN) or WorkBuddy AI desktop app is installed and signed in on this machine. The plugin reuses the app's sign-in state and follows account switches automatically; the two never affect each other.

**Recommended: let an Agent you already have do the install** — any assistant with terminal and file access (the DSH agent, Codex, Claude Code, Cursor, …). Paste this to it verbatim:

```text
Please install and verify the DSH (DeepSeek Harness) plugin dsh-workbuddy-connect for me (project: https://github.com/corrinehu/dsh-workbuddy-connect).
Start by reading the project README and confirming which interface I actually use (Web / Desktop / TUI) and its DSH core version — for the Desktop app, the bundled core, never the standalone CLI's version.
Then install from the official npm package per the version mapping (0.2.0-rc.2 -> 0.7.6, rc.1 -> 0.7.0, 0.1.5-0.1.7 -> 0.6.5), preferring a locally supported non-market channel; on some Desktop distributions (the official Electron app in particular) the profile is app-managed and rules vary by distribution — check mine first, then explore its compliant install route, but never bypass its validation.
Ask for my consent and make backups before changing any local files or configuration.
After installing, verify the WorkBuddy group appears in the model picker and walk me through one short conversation.
If the Desktop install still fails generation validation (e.g. the @types/retry false positive), report it honestly, reference upstream dataelement/dsh-desktop#688, and suggest switching to the standalone Web / TUI — do not modify dependency packages or bypass the check.
```

Core-to-plugin quick reference (full table in "Compatibility and release history" at the end):

| DSH core | Recommended plugin |
|---|---|
| 0.2.0-rc.2 | 0.7.6 (npm latest) |
| 0.2.0-rc.1 | 0.7.0 |
| 0.1.5 – 0.1.7 | 0.6.5 |

<details>
<summary>Manual install (command line, Web / TUI only)</summary>

```sh
# Web (pin per your actual core — example: 0.2.0-rc.2 -> 0.7.6; or install from source via github:corrinehu/dsh-workbuddy-connect)
dsh plugin --profile web add dsh-workbuddy-connect@0.7.6
dsh web

# TUI (example for a 0.1.x core; that profile needs pnpm 11, e.g. npx pnpm@11)
dsh plugin --profile dsh-tui add dsh-workbuddy-connect@0.6.5
dsh --profile dsh-tui
```

</details>

> **TUI version pairing**: the terminal shell `@deepseek-harness-tui/dsh-tui` must be 0.10.0-beta.5 or newer — older versions fail at startup with this plugin installed (`events is not iterable`); manual reasoning-level detection exists on Web / Desktop only, not TUI.

> **Desktop**: on some Desktop distributions (the official Electron app in particular) the `desktop` profile is app-managed, and the official app rejects the standalone CLI's `--profile desktop`; other distributions may follow different rules, so check yours first and do not blindly use the standalone CLI's `--profile desktop`. An Agent may probe whether your distribution offers a compliant non-market install route, but that is not guaranteed to work; never blindly edit the app-managed directory or bypass its validation.

**Verify**: after restarting the interface, the model picker shows the "WorkBuddy / WorkBuddy AI" group(s) (with only one app installed, check just that group), and a model picked from the group completes one short conversation with a normal reply — that is what a successful install means.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **CN and international side by side**: the CN app appears as the WorkBuddy group and the international one (WorkBuddy AI) as the WorkBuddy AI group; their models, accounts, and credit never mix. Each group follows only its own app's sign-in — install just the international app and only WorkBuddy AI appears, install both and both groups appear, sign out of one and that group goes away. Settings shows one card per version, each with its own account and balance.

![WorkBuddy AI models in the DSH model picker](assets/5.png)

- **Image input**: most models accept images pasted or dropped straight into the conversation (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1) clearly say so.

- **Reasoning levels**: levels explicitly declared by WorkBuddy appear directly — for example, GLM-5.3 and GLM-5.3-Flash offer low / high / max. For models without declared levels, Web and Desktop offer a manual check in the model picker (it sends a few requests and may consume credit); models without a check result or selectable levels keep using WorkBuddy's default.

- **Balance at a glance**: with a WorkBuddy / WorkBuddy AI model selected, the composer shows the account's remaining credit next to the model selector (e.g. `WB.3,401 credits`, `WB AI.3,401 credits` on the international app). Credit is not polled automatically (every status read is a real billing query): one read on mount, then refresh on demand with the ↻ beside it. During session switching, the controls may briefly hide until the model selection is ready, then return automatically. The refresh button remains available even when the model has no reasoning-level detection entry or the balance cannot be read.

- **Status and detection**: Settings → Plugins → the matching card shows the account, token validity, remaining credit, and model offers; it also refreshes the model list manually, shows whether the current list came from the upstream or the built-in fallback, and runs manual reasoning-level detection for eligible models. On DSH 0.1.5 the entry lives under Settings → Plugins; on 0.1.6+ it moved to the left-sidebar Plugins panel (workbuddy-connect → View) — and the Settings → Models page shows no WorkBuddy entries on either generation, by design.

- **Model visibility**: the Context window tab of each card lets you check which models appear in the model picker. Hidden lists are saved per signed-in account: switching accounts switches to that account's own list, switching back restores it; new accounts and newly added models are visible by default. Hiding only affects pickability — existing chats using a hidden model keep working.

![Model visibility in the context-window list (DSH 0.1.6+ plugin configuration page)](assets/6.png)

The same UI works unchanged inside the DSH 0.1.5 settings cards:

![Model visibility in a DSH 0.1.5 settings card](assets/7.png)

- **Enterprise credit**: on the CN product, enterprise accounts (non-empty `enterpriseId`) read their cycle quota from the enterprise billing endpoint, and the card shows the enterprise quota with the cycle reset time.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown; the rate is display-only and never affects requests.

- **Promo badges**: promo badges (limited-time free, night discount) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model, and the status card collects currently discounted models — per WorkBuddy service data, synced each time DSH starts. The international version's promotions come from the service's `modelPromotions` (with an effective window); once a promotion lapses its badge is withdrawn, and because the service writes the discounted value into the model's own rate field, the original price cannot be reconstructed — the model then reports "price unavailable — refresh to update" instead of repeating the discounted rate or claiming it is free.

![Settings card showing the plugin](assets/2.png)

The expanded card has three tabs: Status shows the account, token validity, total credit, catalog source, and reasoning-level detection; Context lists each model's context window, and the international version's "use the upstream's largest declared context window" switch lives here (on by default, so DSH sizes context compression to the largest declared window; turn it off to follow the upstream default instead, and the preference persists across restarts); Details shows per-package credit and model offers. The CN and international versions each get their own card.

![Settings card showing account and remaining credit](assets/3.png)

## Why reasoning levels work this way

Information about WorkBuddy models' reasoning levels is currently split between upstream API responses and private UI logic in the client, while the model catalog changes quickly. If the plugin filled in one uniform set of levels for every model without an upstream declaration, it would need to keep chasing unpublished product logic with no stable contract.

![Reasoning-level detection in the composer](assets/4.png)

Testing also found that some models accept the `reasoning_effort` parameter while ignoring unknown values and falling back to their default behavior. A successful request alone therefore does not prove that a level is actually usable.

For models without declared levels, Web and Desktop instead use user-authorized, on-demand detection: it first confirms that the upstream validates the parameter, then checks which standard levels it accepts. The check sends a few requests and may consume credit. Its result means only that the upstream currently accepts that level; it does not promise a particular change in reasoning quality, speed, or credit use.

## CLI

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available). The `desktop` profile is generally managed by the desktop app, so the CLI (including `exec`) does not work against it (see the Desktop note under Install).

Both commands target the CN version by default; add `--provider workbuddy-ai` for the international one:

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` removes only that version's plugin-owned credential copy. It leaves the desktop app's own sign-in alone and does not promise the model group will disappear (the app's credential file still supplies one).

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profiles (as of 0.3.2 this requires `0.1.5-rc.1`+ and Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` (or `WORKBUDDY_AI_AUTH_FILE` for the international version) at the actual file.
- **Encrypted desktop credential helper discovery**: the helper is auto-detected on macOS and Windows; on Windows the CN app checks the default path `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` first and then the uninstall registry records, while the international app has no verified default path and checks the registry only. If auto-detection fails, set `WORKBUDDY_ELECTRON_BIN` (CN) or `WORKBUDDY_AI_ELECTRON_BIN` (international) to the executable explicitly, then fully quit and restart DSH for the change to take effect. Linux has no auto-discovery; an explicit environment variable is required. When WSL invokes the Windows-side helper, the plugin automatically normalizes the `ELECTRON_RUN_AS_NODE` entry in the child's `WSLENV` to a single safe flag set (carrying `/w` for forwarding, with no path translation; all other entries are preserved) — no manual `WSLENV` setup is needed. This change has passed offline regression tests; real WSL2 / Windows verification remains outstanding.
- **The international version's model catalog comes from the app's own interface**: the service splits it by User-Agent, which is a private implementation detail that a server-side change can break. When that happens the plugin degrades to this account's last successful catalog and then to its built-in roster, showing the source (live / saved / built-in), the fetch time, and the failure reason on the card — but long-term compatibility is not guaranteed. The CN version's catalog uses the same interface as the official CLI and is unaffected.
- **International-version environments not yet covered**: on Windows / WSL / Linux no reliable source for the international app's version has been located yet, so the saved value or the built-in default is used. On macOS, real-shim checks covered complete GPT-family replies, tool calls, and continued turns.
- **Behaviour change with no credentials**: a version whose app was never signed in — and that left no plugin-owned copy — no longer shows a model group. The CN version used to display a built-in fallback list, but every model on it failed when selected.
- **The enterprise credit path currently covers the CN product only**: the international enterprise billing interface is unverified, so those accounts still read through the personal endpoint pending measurement. The enterprise branch could not be tested locally (the development machine holds a personal account); it was implemented from the official app's interface contract, and reports from enterprise users are welcome.
- **Settings entries vary with the DSH version**: on 0.1.5 / 0.1.6 the plugin installs its settings sections as before (`authFile` / `authFileAI` stay readable from `settings.yaml` and the TUI `/settings`); on 0.1.7+ / 0.2.0 the settings service no longer offers that interface, so the plugin degrades to a settings-less provider — models, the picker, model visibility, and context windows keep working; only the "use the upstream's declared maximum context window" preference stops being persistable.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Compatibility and release history

The plugin version must match the DSH core — a mismatched combination fails to start DSH — and the Desktop app picks its plugin version by the bundled core. The newest npm release is not necessarily right for you: match your actual core first.

| DSH core | Recommended plugin | Notes |
|---|---|---|
| `0.2.0-rc.2` | `0.7.6` (npm latest) | Current line; fixes enterprise catalog gaps and international chat requests blocked by the upstream channel check. Avoid 0.7.2 with its registry regression. |
| `0.2.0-rc.1` | `0.7.0` | 0.7.1 drops rc.1 support; stay on this version. |
| `0.1.5` – `0.1.7` | `0.6.5` | Final release for the old cores; 0.7.0 targets 0.2.0 only. |
| `0.1.2-rc.1` | `0.3.1` | Older line, historical maintenance only. |
| `0.1.1-rc.2` | `0.2.6` | Older line, historical maintenance only. |

Release history (full records at [releases](https://github.com/corrinehu/dsh-workbuddy-connect/releases)):

- **0.7.6**: fixes enterprise accounts missing `glm-5.3-flashx` from the model catalog ([#123](https://github.com/corrinehu/dsh-workbuddy-connect/issues/123)), and fixes international chat requests being blocked by the upstream channel check ([#139](https://github.com/corrinehu/dsh-workbuddy-connect/issues/139) / [#142](https://github.com/corrinehu/dsh-workbuddy-connect/issues/142)).
- **0.7.5**: restores composer controls after session switching ([#125](https://github.com/corrinehu/dsh-workbuddy-connect/issues/125) / [#132](https://github.com/corrinehu/dsh-workbuddy-connect/issues/132)), fixes WSL helper environment forwarding ([#133](https://github.com/corrinehu/dsh-workbuddy-connect/issues/133)), and adds community projects to both READMEs.
- **0.7.4**: Windows diagnostics and stability improvements: accurate classification of oversized registry-subprocess output, cross-platform test-assumption fixes ([#62](https://github.com/corrinehu/dsh-workbuddy-connect/issues/62)), and a reworked install section.
- **0.7.3**: fixes Windows registry auto-discovery failing on non-default install paths ([#105](https://github.com/corrinehu/dsh-workbuddy-connect/issues/105)).
- **0.7.2**: pi-ai becomes a plugin-bundled dependency and rejected inference-field requests are fixed ([#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)); this release carries a Windows registry regression — use 0.7.4 or a newer stable release.
- **0.7.1**: narrows the pi-ai dependency range.
- **0.7.0**: adapts to DSH 0.2.0's settings-service rework and drops 0.1.x support.
- **0.6.5**: final release of the 0.1.x line.

Pinned-version install example: `dsh plugin --profile web add dsh-workbuddy-connect@0.7.6`.

**Do not upgrade the profile-level `@earendil-works/pi-ai` to 1.x**: this plugin and the `0.2.0-rc.2` generation of the DSH core both require `^0.87.1` (bundled by the plugin since 0.7.2), and third-party plugin managers' "updatable" prompts do not check peer constraints — do not act on them ([#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86)); likewise, do not blindly remove a leftover `overrides: {'@earendil-works/pi-ai': '0.87.1'}` until you have confirmed nothing else depends on it.

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Related Projects / Community Ecosystem

- **[HanaAgent](https://github.com/liliMozi/openhanako)**: an independent personal AI Agent project.
- **[hana-workbuddy-connect](https://github.com/miaoyongxu/hana-workbuddy-connect)**: a community-maintained unofficial adapter project that reuses parts of the `dsh-workbuddy-connect` implementation to bring WorkBuddy / WorkBuddy AI models to HanaAgent.

Both projects are maintained independently by third parties. The compatibility, security, and usage support of `hana-workbuddy-connect` are the responsibility of its maintainer. Listing them here is not an official endorsement, nor does it imply any stability or compatibility commitment on this plugin's internal interfaces.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
