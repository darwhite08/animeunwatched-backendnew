# Locked Features Registry

Each entry below is FROZEN. Claude Code must not edit the listed paths, and the
listed tests must stay green. To change a locked feature, see "Unlocking" at the
bottom — that is a deliberate human action.

---

## <feature-id>
- Locked since: <date>
- Paths: <glob(s), comma-separated>
- Public contract: <the one file other code is allowed to import>
- Locked tests: <path under tests/locked/>
- Why: <one line>

<!-- Example (delete or adapt):
## dm-getmessages
- Locked since: 2026-06-08
- Paths: app/src/modules/chat/chat.service.ts
- Public contract: app/src/modules/chat/chat.service.ts
- Locked tests: tests/locked/dm-getmessages.test.ts
- Why: getMessages must never silently return 0 messages (regressed once via a null-unsafe expiresAt filter).
-->

---

## dm-getmessages
- Locked since: 2026-06-08
- Paths: app/src/modules/chat/chat.service.ts (function: getMessages)
- Public contract: app/src/modules/chat/chat.service.ts
- Locked tests: tests/locked/dm-getmessages.test.ts
- Why: getMessages must return a conversation's messages and keep a NULL-safe expiry
  filter — it once silently returned 0 for every conversation.
- Note: enforced by the locked TEST (behavior), not a file-block — chat.service.ts is a
  large shared file, so it is intentionally NOT in locked-paths.txt. Add it there only
  if you want to hard-block all edits to that file.

## Unlocking (deliberate change to a locked feature)
1. Remove or edit the feature's entry here AND its line(s) in `locked-paths.txt`.
2. Make the change; update the locked test ON PURPOSE to reflect new behavior.
3. Re-add the entry and paths to re-lock.
Claude must never do steps 1 or 2 on its own — only the human unlocks.
