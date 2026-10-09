# Third-party inventory — foundation preview

This is an initial direct-dependency inventory, **not a complete redistribution notice bundle**. `pnpm-lock.yaml` and `src-tauri/Cargo.lock` contain exact resolved dependencies. CI checks Rust licenses against `deny.toml`; collect the complete transitive license texts before distributing an installer.

| Component | License / source |
| --- | --- |
| Tauri, tauri-build, official dialog/global-shortcut/single-instance plugins | MIT OR Apache-2.0; https://github.com/tauri-apps |
| React, React DOM | MIT; https://github.com/facebook/react |
| Vite, Vitest, React Vite plugin | MIT; https://github.com/vitejs and https://github.com/vitest-dev |
| TypeScript | Apache-2.0; https://github.com/microsoft/TypeScript |
| Testing Library, ESLint, typescript-eslint, Prettier, jsdom, DefinitelyTyped types | MIT; respective package manifests and license files |
| rusqlite | MIT; https://github.com/rusqlite/rusqlite |
| Bundled SQLite | Public domain; https://www.sqlite.org/copyright.html |
| serde, serde_json, thiserror, uuid, time, tempfile | MIT OR Apache-2.0; respective crate manifests and license files |
| Installed Ponytail skills | MIT, DietrichGebert; `.pi/skills/ponytail-bundle/LICENSE` |

No STT, VAD, diarization, or LLM weights are bundled or downloaded by this build. The fictional meeting fixture and app icon were authored for this project under its MIT license. Meetily was reviewed as a reference; its source was not copied.
