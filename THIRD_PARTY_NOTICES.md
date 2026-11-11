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
