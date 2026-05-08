# (Mirror) Frontend API client conventions

**Read-only mirror of `animeunwatchedfrontend/docs/api-client.md`.**

Source of truth lives in the frontend repo. Do not edit here.

Last synced: 2026-05-08

To re-sync:

```bash
curl -fsSL https://raw.githubusercontent.com/darwhite08/animeunwatched-frontend/main/docs/api-client.md \
  -o docs/peer/frontend-api-client.md
# then update the "Last synced" line above to today's date and commit
```

---

(Contents follow on next sync. The frontend's `docs/api-client.md` describes:
- `lib/api/client.ts`: fetch wrapper that attaches `Authorization: Bearer <accessToken>` and handles 401 → refresh → retry once
- `lib/api/endpoints.ts`: one typed function per backend endpoint, named after the path
- `lib/api/types.ts`: hand-maintained or codegen'd from `/api/v1/openapi.json`
- Refresh cookie is httpOnly and set by the backend; the frontend never reads it
- Socket.io client at `lib/socket.ts` connects with the access token, listens for `notification.new`, surfaces via Zustand store)
