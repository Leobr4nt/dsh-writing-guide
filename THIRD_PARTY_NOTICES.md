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
