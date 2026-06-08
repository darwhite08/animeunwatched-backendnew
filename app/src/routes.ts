import { Router } from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { animeRouter } from "./modules/anime/anime.routes";
import { usersRouter } from "./modules/users/users.routes";
import { listsRouter } from "./modules/lists/lists.routes";
import { postsRouter } from "./modules/posts/posts.routes";
import { shotsRouter } from "./modules/shots/shots.routes";
import { storiesRouter } from "./modules/stories/stories.routes";
import { blockRouter, reportsRouter } from "./modules/safety/safety.routes";
import { e2eeRouter } from "./modules/e2ee/e2ee.routes";
import { webauthnRouter } from "./modules/e2ee/webauthn.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { reviewsRouter, reviewsAnimeRouter } from "./modules/reviews/reviews.routes";
import { blogsRouter } from "./modules/blogs/blogs.routes";
import { searchRouter } from "./modules/search/search.routes";
import { clubsRouter } from "./modules/clubs/clubs.routes";
import { threadsRouter, animeThreadsRouter } from "./modules/threads/threads.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { creatorRouter } from "./modules/creator/creator.routes";
import { monetizationRouter } from "./modules/monetization/monetization.routes";
import { pollsRouter } from "./modules/polls/polls.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes";
import { chatRouter } from "./modules/chat/chat.routes";
import { groupsRouter } from "./modules/groups/groups.routes";
import { eventsRouter } from "./modules/events/events.routes";
import { configRouter } from "./modules/config/config.routes";
import { pushRouter } from "./modules/push/push.routes";
import { uploadsRouter } from "./modules/uploads/uploads.routes";
import { discoveryRouter } from "./modules/discovery/discovery.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { versionRouter } from "./modules/version/version.routes";
import { activitiesRouter } from "./modules/activities/activities.routes";
import { oauthRouter } from "./modules/oauth/oauth.routes";
import { changelogRouter } from "./modules/changelog/changelog.routes";
import { ticketsRouter } from "./modules/tickets/tickets.routes";
import { clubThreadsRouter } from "./modules/threads/threads.routes";

/**
 * Source of truth for what's mounted under /api/v1. Single array consumed
 * by both the real router (so Express knows what to serve) and the
 * OpenAPI builder (so the spec stays in sync with the routes by
 * construction — no manual maintenance).
 *
 * Adding a new top-level resource? Append one tuple here.
 */
export const ROUTE_MOUNTS = [
  ["/auth",                            authRouter],
  ["/anime",                           animeRouter],
  ["/anime/:animeId/reviews",          reviewsAnimeRouter],
  ["/anime/:malId/threads",            animeThreadsRouter],
  // Block routes mount on /users BEFORE usersRouter so /users/blocked and
  // /users/:id/block resolve before usersRouter's /:username catch-all.
  ["/users",                           blockRouter],
  ["/users",                           usersRouter],
  ["/reports",                         reportsRouter],
  ["/e2ee",                            e2eeRouter],
  ["/webauthn",                        webauthnRouter],
  ["/lists",                           listsRouter],
  ["/posts",                           postsRouter],
  ["/shots",                           shotsRouter],
  ["/stories",                         storiesRouter],
  ["/activities",                      activitiesRouter],
  ["/notifications",                   notificationsRouter],
  ["/reviews",                         reviewsRouter],
  ["/blogs",                           blogsRouter],
  ["/search",                          searchRouter],
  ["/clubs",                           clubsRouter],
  ["/clubs/:slug/threads",             clubThreadsRouter],   // nested mount on clubsRouter
  ["/threads",                         threadsRouter],
  ["/admin",                           adminRouter],
  ["/creator",                         creatorRouter],
  ["/monetization",                    monetizationRouter],
  ["/polls",                           pollsRouter],
  ["/analytics",                       analyticsRouter],
  ["/webhooks",                        webhooksRouter],
  ["/chat",                            chatRouter],
  ["/groups",                          groupsRouter],
  ["/events",                          eventsRouter],
  ["/push",                            pushRouter],
  ["/uploads",                         uploadsRouter],
  ["/discovery",                       discoveryRouter],
  ["/ai",                              aiRouter],
  ["/config",                          configRouter],
  ["/version",                         versionRouter],
  ["/oauth",                           oauthRouter],
  ["/changelog",                       changelogRouter],
  ["/tickets",                         ticketsRouter],
] as const;

const router = Router();

// Mount everything from the canonical list. ROUTE_MOUNTS lists the nested
// clubsThreadsRouter — but clubs.routes already mounts it internally, so
// we skip the duplicate at the top level here.
for (const [prefix, sub] of ROUTE_MOUNTS) {
  if (prefix === "/clubs/:slug/threads") continue;
  router.use(prefix, sub);
}

export default router;
