# Locked characterization tests

Tests here pin the **current** behavior of locked features (see `.claude/LOCKED.md`).
They run on every turn end via the Stop hook (`npm run test:locked`) and on a
blocked edit. If a change reds one of these, a locked feature regressed — fix the
change, don't weaken the test.

Add one file per locked feature, e.g. `dm-getmessages.test.ts`. Import only the
feature's public contract (the `@` alias maps to `./app`). Until you add a test,
`test:locked` passes via `--passWithNoTests`.
