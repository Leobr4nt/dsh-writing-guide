# Dependencies and compatibility references

The extension runtime uses EJS 3.1.10 (Apache-2.0), quickjs-emscripten-core
0.32.0 and @jitl/quickjs-wasmfile-release-sync 0.32.0 (MIT).
Their distribution packages retain their license notices; package-lock.json pins integrity.

This plugin independently implements a limited subset of public data/API contracts
from the following reference projects. Their source and distribution bundles are not
included, installed into DSH, or relicensed by this repository:

- SillyTavern, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`:
  regex engine semantics and preset/character data contracts (AGPL-3.0).
- JS-Slash-Runner, commit `91a706cfcc884baae3c9da47e5d672901a5d65a6`:
  script import format, chat/script variables and read-only chat message API
  (PolyForm NonCommercial 1.0.0).
- ST-Prompt-Template, commit `d6f520d149aba146305b0b781ddd691d449c28d2`:
  EJS tags and basic local/message/cache getvar/setvar API (AGPL-3.0).

Compatibility with a format does not imply complete compatibility with its host,
DOM, event system, network access, slash commands, or third-party extensions.

Resident browser runtime dependencies: playwright-core (Apache-2.0), esbuild, jQuery, Lodash, Vue, Zod (MIT), and YAML (ISC), at versions pinned by package-lock.json. Public MagVarUpdate reference commit d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc (MIT) was consulted. Third-party runtime module source is fetched into the user data cache with hashes; no user material or fetched module bundle is included in this repository. The helper API version reports the adapter target contract, not installation of the original Tavern Helper plugin. Unsupported APIs remain diagnostic failures.

Version 0.4.1 adds jQuery UI 1.14.1 (MIT), loaded inside the isolated browser to provide its actual widgets, including draggable. The installed dependency retains its license. Public worldbook conversion fields, script-button contracts and SillyTavern context names were checked against the reference commits above; the adapter is an independent implementation.

Version 0.4.6 checks ordinary local-variable behavior against SillyTavern's public `scripts/variables.js`, `scripts/macros/definitions/variable-macros.js` and `MacroEngine.normalizeMacroResult` at commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. The independent adapter uses per-request transaction copies and commits to this plugin's existing per-session chat-variable store only after successful generation. This transaction timing is a deliberate host adaptation; it does not implement global-variable macros or the entire SillyTavern macro grammar.

Version 0.5.0 adds marked 17.0.1 (MIT), sanitize-html 2.18.1 (MIT), and Ajv 8.20.0 (MIT), pinned in package-lock.json. Upstream packages retain their notices. SPreset configuration and function-call behavior was studied in `starowo/starowo.github.io/regex_bind/inject.js`, commit `53bd585da14248ba10baaede7fc7ed0cebe1eeeb`, and the older `starowo/SPreset` commit `7c4d91f548bc310d97e761becdc4026a11dc5cd7`. The upstream extension is not bundled or injected into DSH; `lib/spreset.js` is an independent subset adapter. SillyTavern prompt-converter behavior was consulted for text-role postprocessing. The reading view uses DSH's documented `conversation.view` slot rather than rewriting the host DOM. Public dsh-preset-enhance display implementation was read for comparison only, not copied into the plugin.

Dependency maintenance for 0.5.0 also updates Vue, Lodash, YAML and Zod to the exact versions in package-lock.json. The final production npm audit reported no known vulnerabilities at validation time; this is a point-in-time package advisory check, not a guarantee of complete runtime security.

Version 0.5.1 explicitly depends on htmlparser2 10.0.0 (MIT) for preserving full HTML documents and ipaddr.js 2.2.0 (MIT) for public-address checks. Dependency licenses are retained in installed packages. Reading documents execute in a separate browser context, not the DSH application document. Public image caching uses an independent, credential-free downloader.

Version 0.5.10 adds undici 7.30.2 (MIT), pinned by package-lock.json, to access the official getGlobalDispatcher API. Writing requests delegate to the existing dispatcher while letting the configured total response deadline own timing. Installed package licenses are retained.
