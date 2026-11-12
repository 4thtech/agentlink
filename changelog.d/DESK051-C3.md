### Changed

- Desktop app on Mac (DESK051-C3, S2): the Touch ID sheet now shows the AgentLink name and icon instead of a generic program icon. The presence helper ships as a small AgentLink app inside the desktop app (same fixed identity, still checked after signing).
- Desktop app on Mac (DESK051-C3): the first-open steps for the unsigned preview now use **Open Anyway** in System Settings, Privacy & Security (or Control-click, Open on macOS 13 and 14); the Terminal line stays only for a "damaged" message. The `.dmg` carries a short "Read me first" file with these steps.

### Fixed

- Desktop build (DESK051-C3): the desktop CI workflow builds the presence helper with the arguments the build script takes and hands it to the app build (Windows: with the MSVC environment); the build scripts hash through `@4thtech-io/crypto` and pass the dependency-boundary check; a CI test that chooses which jobs run no longer runs the relay tests for every CLI change.
