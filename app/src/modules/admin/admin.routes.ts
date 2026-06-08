import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { requirePermission, requirePermissionWithStepUp } from "../../lib/permissions";
import * as ctrl       from "./admin.controller";
import * as users      from "./users.controller";
import * as roles      from "./roles.controller";
import * as auditCtrl  from "./auditLog.controller";
import * as stepup     from "./stepup.controller";
import * as flags      from "./flags.controller";
import * as ents       from "./entitlements.controller";
import * as imp        from "./impersonation.controller";
import * as content    from "./content.controller";
import * as dsr        from "./dsr.controller";
import * as apiKeys    from "./apiKeys.controller";
import * as webhooks   from "./webhooks.controller";
import * as ann        from "./announcements.controller";
import * as settings   from "./settings.controller";
import * as jobs       from "./jobs.controller";
import * as sync       from "./sync.controller";
import * as deps       from "./dependencies.controller";
import * as security   from "./security.controller";
import * as templates  from "./templates.controller";
import * as adminTeam  from "./adminTeam.controller";
import * as modq       from "./moderationQueue.controller";
import * as billing    from "./billing.controller";
import * as loginHist  from "./loginHistory.controller";
import * as undo       from "./undo.controller";
import * as search     from "./search.controller";
import * as reports    from "./reports.controller";
import * as mailer     from "./mailer.controller";
import * as inspect    from "./inspect.controller";
import * as cRules     from "./contentRules.controller";
import * as modAct     from "./modActivity.controller";
import * as anomalies  from "./anomalies.controller";
import * as incidents  from "./incidents.controller";
import * as maint      from "./maintenance.controller";
import * as savedRep   from "./savedReplies.controller";
import * as sla        from "./sla.controller";
import * as openApi    from "./openapi.controller";
import * as pii        from "./pii.controller";
import * as approvals  from "./approvals.controller";
import { requireApproval } from "../../lib/approvals";
import * as oauthClients from "./oauthClients.controller";
import * as scimAdmin    from "./scim.controller";
import * as samlCfg      from "./samlConfigs.controller";
import * as cost         from "./cost.controller";
import * as dx           from "./dx.controller";
import * as compliance   from "./compliance.controller";
import * as aiOps        from "./aiOps.controller";
import * as obs          from "./observability.controller";
import * as secX         from "./securityExtras.controller";
import * as trust        from "./trustCenter.controller";
import * as tickets      from "./tickets.controller";
import * as traces       from "./traces.controller";
import * as logs         from "./logs.controller";
import * as tHooks       from "./ticketWebhooks.controller";
import * as exps         from "./experiments.controller";
import * as onCall       from "./onCall.controller";
import * as backups      from "./backups.controller";
import * as userNotes    from "./userNotes.controller";
import * as dashboards   from "./dashboards.controller";
import * as exportsCtrl  from "./exports.controller";
import * as notifyCh     from "./notifyChannels.controller";
import * as platformH    from "./platformHealth.controller";
import * as inbox        from "./inbox.controller";
import * as savedSrch    from "./savedSearches.controller";
import * as integ        from "./integrations.controller";
import * as triage       from "./triage.controller";
import * as flagsExtras  from "./flagsExtras.controller";
import * as creators     from "./creators.controller";

export const adminRouter = Router();

// Every admin route requires a valid Bearer token AND legacy role=ADMIN.
// Fine-grained permission checks layer on top via requirePermission(...).
adminRouter.use(requireAuth, requireAdmin);

// Headline / overview
adminRouter.get("/stats",              ctrl.getStats);
adminRouter.get("/health",             ctrl.getPlatformHealth);
adminRouter.get("/metrics/overview",   ctrl.getMetricsOverview);
adminRouter.get("/analytics/live",     ctrl.getAnalyticsLive);
adminRouter.get("/ga/realtime",        ctrl.getGAAnalyticsLive);
adminRouter.get("/metrics/timeseries", ctrl.getTimeSeries);
adminRouter.get("/metrics/top",        ctrl.getTopPerformers);
adminRouter.get("/metrics/funnel",     ctrl.getFunnel);
adminRouter.get("/metrics/system",     ctrl.getSystemMetrics);

// Users — read
adminRouter.get("/users",                  requirePermission("users","read"),  ctrl.listUsers);
adminRouter.get("/users/recent",           requirePermission("users","read"),  ctrl.getRecentUsers);
adminRouter.get("/users/:userId",          requirePermission("users","read"),  ctrl.getUserDetail);
adminRouter.get("/users/:userId/triage",   requirePermission("users","read"),  triage.getUserTriage);

// Users — mutations
adminRouter.patch( "/users/:userId",                  requirePermission("users","update"),           users.patchUser);
adminRouter.post(  "/users/:userId/ban",              requirePermission("users","suspend"),          ctrl.banUser);
adminRouter.post(  "/users/:userId/unban",            requirePermission("users","suspend"),          ctrl.unbanUser);
adminRouter.post(  "/users/:userId/role",             requirePermissionWithStepUp("users","role"),   ctrl.setUserRole);
adminRouter.post(  "/users/:userId/password-reset",   requirePermission("users","reset_password"),   users.passwordReset);
adminRouter.post(  "/users/:userId/mfa-reset",        requirePermission("users","reset_mfa"),        users.resetMfa);
adminRouter.post(  "/users/:userId/revoke-sessions",  requirePermission("users","revoke_sessions"),  users.revokeSessions);
adminRouter.get(   "/users/:userId/sessions",         requirePermission("users","read"),             users.getUserSessions);
adminRouter.delete("/users/:userId",                  requirePermissionWithStepUp("users","delete"),
  requireApproval({ action: "users.delete", resource: (r) => `user:${r.params.userId}` }),
  users.softDelete);
adminRouter.post(  "/users/bulk",                     requirePermission("users","suspend"),          users.bulkAction);

// Creators — hand-pick who gets Creator Studio access (status="active")
adminRouter.get(  "/creators",                       requirePermission("users","read"),   creators.listCreators);
adminRouter.post( "/creators/:userId/grant",         requirePermission("users","update"), creators.grantCreator);
adminRouter.post( "/creators/:userId/revoke",        requirePermission("users","update"), creators.revokeCreator);
adminRouter.post( "/creators/:userId/bonus",         requirePermissionWithStepUp("users","update"), creators.grantBonus);
adminRouter.post( "/creators/:userId/bonus/revoke",  requirePermissionWithStepUp("users","update"), creators.revokeBonus);

// Invites
adminRouter.get(   "/invites",                        requirePermission("users","read"),   users.listInvites);
adminRouter.post(  "/invites",                        requirePermission("users","create"), users.createInvite);
adminRouter.delete("/invites/:inviteId",              requirePermission("users","create"), users.revokeInvite);

// RBAC
adminRouter.get(   "/permissions",                    requirePermission("roles","read"),            roles.listPermissions);
adminRouter.get(   "/roles",                          requirePermission("roles","read"),            roles.listRoles);
adminRouter.post(  "/roles",                          requirePermissionWithStepUp("roles","write"), roles.createRole);
adminRouter.patch( "/roles/:roleId",                  requirePermissionWithStepUp("roles","write"), roles.updateRole);
adminRouter.delete("/roles/:roleId",                  requirePermissionWithStepUp("roles","write"), roles.deleteRole);
adminRouter.get(   "/roles/diff",                     requirePermission("roles","read"),            roles.diffRoles);
adminRouter.get(   "/users/:userId/admin-roles",      requirePermission("roles","read"),            roles.getUserRoles);
adminRouter.post(  "/users/:userId/admin-roles",      requirePermissionWithStepUp("roles","write"), roles.grantUserRole);
adminRouter.delete("/users/:userId/admin-roles",      requirePermissionWithStepUp("roles","write"), roles.revokeUserRole);

// Moderation queue
adminRouter.get("/reports",                requirePermission("moderation","read"), ctrl.listReports);
adminRouter.patch("/reports/:reportId",    requirePermission("moderation","act"),  ctrl.resolveReport);

// Legacy audit (SecurityEvent — auth events)
adminRouter.get("/audit",                  requirePermission("audit","read"), ctrl.listAuditLog);

// Admin AuditLog (hash-chained, append-only)
adminRouter.get("/audit/admin",            requirePermission("audit","read"),   auditCtrl.listAuditLog);
adminRouter.get("/audit/admin/export",     requirePermission("audit","export"), auditCtrl.exportAuditLog);
adminRouter.get("/audit/admin/verify",     requirePermission("audit","read"),   auditCtrl.verifyAuditChain);

// Step-up authentication — no extra permission gate; the password+TOTP IS the gate
adminRouter.post("/stepup",                stepup.requestStepUp);

// Feature flags & overrides
adminRouter.get(   "/flags",                          requirePermission("flags","read"),            flags.listFlags);
adminRouter.post(  "/flags",                          requirePermissionWithStepUp("flags","write"), flags.createFlag);
adminRouter.patch( "/flags/:flagId",                  requirePermission("flags","write"),           flags.updateFlag);
adminRouter.delete("/flags/:flagId",                  requirePermissionWithStepUp("flags","write"), flags.deleteFlag);
adminRouter.post(  "/flags/:flagId/kill",             requirePermissionWithStepUp("flags","kill"),  flags.killFlag);
adminRouter.post(  "/flags/:flagId/revive",           requirePermissionWithStepUp("flags","kill"),  flags.reviveFlag);
adminRouter.get(   "/flags/:flagId/overrides",        requirePermission("flags","read"),            flags.listOverrides);
adminRouter.post(  "/flags/:flagId/overrides",        requirePermission("flags","write"),           flags.createOverride);
adminRouter.delete("/flags/overrides/:overrideId",    requirePermission("flags","write"),           flags.deleteOverride);
adminRouter.get(   "/flags/evaluate/:key",            requirePermission("flags","read"),            flags.evaluateFlag);
adminRouter.get(   "/flags/:flagId/impact",           requirePermission("flags","read"),            flagsExtras.getFlagImpact);
adminRouter.get(   "/flags/:flagId/audit",            requirePermission("flags","read"),            flagsExtras.getFlagAudit);
adminRouter.post(  "/flags/:flagId/rollout",          requirePermission("flags","write"),           flagsExtras.setRolloutPercent);

// Entitlements
adminRouter.get(   "/entitlements",                   requirePermission("entitlements","read"),  ents.listEntitlements);
adminRouter.post(  "/entitlements",                   requirePermission("entitlements","write"), ents.grantEntitlement);
adminRouter.delete("/entitlements/:id",               requirePermission("entitlements","write"), ents.revokeEntitlement);

// Impersonation
adminRouter.post(  "/impersonation/start",            requirePermissionWithStepUp("impersonation","start"), imp.startImpersonation);
adminRouter.post(  "/impersonation/stop",             imp.stopImpersonation);
adminRouter.get(   "/impersonation/active",           requirePermission("impersonation","start"),           imp.listActive);

// Content & moderation
adminRouter.get(   "/content/posts",                  requirePermission("moderation","read"), content.listPosts);
adminRouter.delete("/content/posts/:postId",          requirePermission("moderation","act"),  content.deletePost);
// Trending-algorithm manual override (HN-style admin escape hatch).
// manualBoost > 1 promotes; shadowPenalty < 1 silently demotes. Step-up
// required because abuse here lets one operator covertly skew the feed.
import { setPostScoreOverride as setPostScore } from "../posts/posts.controller";
adminRouter.patch( "/content/posts/:id/score",        requirePermissionWithStepUp("moderation","act"), setPostScore);
adminRouter.get(   "/content/clubs",                  requirePermission("moderation","read"), content.listClubs);
adminRouter.delete("/content/clubs/:clubId",          requirePermission("moderation","act"),  content.deleteClub);
adminRouter.post(  "/users/:userId/shadow-ban",       requirePermission("moderation","act"),  content.shadowBanUser);
adminRouter.delete("/users/:userId/shadow-ban",       requirePermission("moderation","act"),  content.unshadowBanUser);

// DSR (Data Subject Requests) — high-risk → step-up
adminRouter.get(   "/dsr/export/:userId",             requirePermissionWithStepUp("dsr","export"), dsr.exportUserData);
adminRouter.get(   "/dsr/preview/:userId",            requirePermission("dsr","export"),           dsr.previewUserData);
adminRouter.get(   "/dsr/recent",                     requirePermission("dsr","export"),           dsr.listRecentDsr);
adminRouter.delete("/dsr/:userId",                    requirePermissionWithStepUp("dsr","delete"), dsr.deleteUserData);

// API keys
adminRouter.get(   "/api-keys",                       requirePermission("api_keys","read"),         apiKeys.listApiKeys);
adminRouter.post(  "/api-keys",                       requirePermissionWithStepUp("api_keys","write"), apiKeys.createApiKey);
adminRouter.post(  "/api-keys/:keyId/rotate",         requirePermissionWithStepUp("api_keys","write"), apiKeys.rotateApiKey);
adminRouter.delete("/api-keys/:keyId",                requirePermissionWithStepUp("api_keys","write"), apiKeys.revokeApiKey);

// Webhooks
adminRouter.get(   "/webhooks",                       requirePermission("webhooks","read"),  webhooks.listEndpoints);
adminRouter.post(  "/webhooks",                       requirePermission("webhooks","write"), webhooks.createEndpoint);
adminRouter.patch( "/webhooks/:endpointId",           requirePermission("webhooks","write"), webhooks.updateEndpoint);
adminRouter.delete("/webhooks/:endpointId",           requirePermission("webhooks","write"), webhooks.deleteEndpoint);
adminRouter.get(   "/webhooks/deliveries",            requirePermission("webhooks","read"),  webhooks.listDeliveries);
adminRouter.post(  "/webhooks/deliveries/:deliveryId/replay", requirePermission("webhooks","replay"), webhooks.replayDelivery);

// Announcements
adminRouter.get(   "/announcements",                  requirePermission("settings","read"),  ann.listAnnouncements);
adminRouter.post(  "/announcements",                  requirePermission("settings","write"), ann.createAnnouncement);
adminRouter.post(  "/announcements/:id/publish",      requirePermission("settings","write"), ann.publishAnnouncement);
adminRouter.delete("/announcements/:id",              requirePermission("settings","write"), ann.deleteAnnouncement);

// Settings
adminRouter.get(   "/settings",                       requirePermission("settings","read"),  settings.listSettings);
adminRouter.get(   "/settings/:key",                  requirePermission("settings","read"),  settings.getSetting);
adminRouter.put(   "/settings/:key",                  requirePermission("settings","write"), settings.upsertSetting);
adminRouter.delete("/settings/:key",                  requirePermission("settings","write"), settings.deleteSetting);

// M9 — jobs + dependency health
adminRouter.get(   "/jobs",                           requirePermission("settings","read"), jobs.getJobs);
adminRouter.post(  "/jobs/:name/retry",               requirePermission("settings","write"), jobs.retryJob);
adminRouter.get(   "/health/dependencies",            requirePermission("settings","read"), deps.getDependencies);

// Anime data sync — queue observability + manual triggers
adminRouter.get(   "/sync/status",                    requirePermission("settings","read"),  sync.getSyncStatus);
adminRouter.post(  "/sync/anime/:malId",              requirePermission("settings","write"), sync.forceSyncAnime);
adminRouter.post(  "/sync/seed",                      requirePermission("settings","write"), sync.seedTop);

// M10 — security policies + events
adminRouter.get(   "/security/policies",              requirePermission("security","read"),  security.getPolicies);
adminRouter.patch( "/security/policies",              requirePermissionWithStepUp("security","write"), security.setPolicy);
adminRouter.get(   "/security/events",                requirePermission("security","read"),  security.listSecurityEvents);

// M14 — notification templates + admin alerts
adminRouter.get(   "/notification-templates",         requirePermission("settings","read"),  templates.listTemplates);
adminRouter.get(   "/notification-templates/:id",     requirePermission("settings","read"),  templates.getTemplate);
adminRouter.post(  "/notification-templates",         requirePermission("settings","write"), templates.createTemplate);
adminRouter.patch( "/notification-templates/:id",     requirePermission("settings","write"), templates.updateTemplate);
adminRouter.delete("/notification-templates/:id",     requirePermission("settings","write"), templates.deleteTemplate);
adminRouter.get(   "/alerts",                         requirePermission("settings","read"),  templates.listAdminAlerts);
adminRouter.post(  "/alerts/:id/ack",                 requirePermission("settings","write"), templates.ackAlert);
adminRouter.post(  "/alerts/bulk-ack",                requirePermission("settings","write"), templates.bulkAckAlerts);

// M15 — admin team
adminRouter.get(   "/admin-team",                     requirePermission("roles","read"),    adminTeam.listAdminTeam);
adminRouter.post(  "/admin-team/:userId/reviewed",    requirePermissionWithStepUp("roles","write"), adminTeam.markReviewed);

// M7 — generic moderation queue
adminRouter.get(   "/moderation/queue",               requirePermission("moderation","read"), modq.listQueue);
adminRouter.post(  "/moderation/queue",               requirePermission("moderation","act"),  modq.createQueueItem);
adminRouter.patch( "/moderation/queue/:id",           requirePermission("moderation","act"),  modq.reviewQueueItem);

// M5 — Billing
adminRouter.get(   "/billing/provider",                requirePermission("billing","read"),    billing.getProviderStatus);
adminRouter.get(   "/billing/plans",                   requirePermission("billing","read"),    billing.listPlans);
adminRouter.post(  "/billing/plans",                   requirePermissionWithStepUp("billing","refund"), billing.createPlan);
adminRouter.get(   "/billing/subscriptions",           requirePermission("billing","read"),    billing.listSubscriptions);
adminRouter.get(   "/billing/subscriptions/:id",       requirePermission("billing","read"),    billing.getSubscription);
adminRouter.post(  "/billing/subscriptions/:id/change-plan",   requirePermissionWithStepUp("billing","refund"), billing.changePlan);
adminRouter.post(  "/billing/invoices/:id/refund",             requirePermissionWithStepUp("billing","refund"),
  requireApproval({ action: "billing.refund", resource: (r) => `invoice:${r.params.id}` }),
  billing.refundInvoice);
adminRouter.post(  "/billing/subscriptions/:id/credit",        requirePermission("billing","credit"),           billing.creditSubscription);
adminRouter.post(  "/billing/subscriptions/:id/extend-trial",  requirePermission("billing","credit"),           billing.extendTrial);
adminRouter.post(  "/billing/subscriptions/:id/cancel",        requirePermissionWithStepUp("billing","refund"), billing.cancelSubscription);

// M2 — login history (per user)
adminRouter.get(   "/users/:userId/login-history",     requirePermission("users","read"),      loginHist.getLoginHistory);

// Undo system
adminRouter.get(   "/undo/recent",                     requirePermission("audit","read"),      undo.getUndoable);
adminRouter.post(  "/undo/:auditId",                   requirePermissionWithStepUp("audit","read"), undo.undoAction);

// Global search (command palette)
adminRouter.get(   "/search",                          requirePermission("users","read"),      search.globalSearch);

// M13 — reports
adminRouter.get(   "/reports",                         requirePermission("audit","read"),      reports.listReportNames);
adminRouter.get(   "/reports/:name",                   requirePermission("audit","read"),      reports.getReport);
adminRouter.get(   "/reports/:name/export",            requirePermission("audit","export"),    reports.exportReport);
adminRouter.get(   "/reports/schedules/list",          requirePermission("audit","read"),      reports.listSchedules);
adminRouter.post(  "/reports/schedules",               requirePermission("audit","export"),    reports.createSchedule);
adminRouter.delete("/reports/schedules/:id",           requirePermission("audit","export"),    reports.deleteSchedule);
adminRouter.post(  "/reports/schedules/:id/run",       requirePermission("audit","export"),    reports.runScheduleNow);

// Public webhook receiver (no auth — but the body must be a valid provider event)
adminRouter.post(  "/billing/webhooks/:provider",      billing.receiveBillingWebhook);

// Mailer status + test-send
adminRouter.get(   "/mailer/status",                   requirePermission("settings","read"),  mailer.getMailerStatus);
adminRouter.post(  "/mailer/test",                     requirePermission("settings","write"), mailer.sendTestEmail);

// Inspection / forensics
adminRouter.get(   "/inspect/search",                  requirePermission("audit","read"),     inspect.inspectSearch);
adminRouter.get(   "/inspect/ip/:ip",                  requirePermission("security","read"),  inspect.getIpDossier);
adminRouter.get(   "/inspect/users/:userId/risk",      requirePermission("users","read"),     inspect.getUserRisk);
adminRouter.get(   "/inspect/users/:userId/similar",   requirePermission("users","read"),     inspect.findSimilarAccounts);
adminRouter.get(   "/inspect/ip-blocks",               requirePermission("security","read"),  inspect.listIpBlocks);
adminRouter.post(  "/inspect/ip-blocks",               requirePermissionWithStepUp("security","write"), inspect.manualBlockIp);
adminRouter.delete("/inspect/ip-blocks/:ip",           requirePermissionWithStepUp("security","write"), inspect.unblockIp);

// Content auto-flag rules
adminRouter.get(   "/content/rules",                   requirePermission("moderation","read"), cRules.listRules);
adminRouter.post(  "/content/rules",                   requirePermission("moderation","act"),  cRules.createRule);
adminRouter.patch( "/content/rules/:id",               requirePermission("moderation","act"),  cRules.updateRule);
adminRouter.delete("/content/rules/:id",               requirePermission("moderation","act"),  cRules.deleteRule);
adminRouter.post(  "/content/rules/test",              requirePermission("moderation","read"), cRules.testRule);

// Moderator activity dashboard + bulk queue actions
adminRouter.get(   "/moderation/activity",             requirePermission("moderation","read"), modAct.getModActivity);
adminRouter.post(  "/moderation/bulk",                 requirePermission("moderation","act"),  modAct.bulkModerate);

// Anomalies (impossible travel, new country, VPN, IP churn, concurrent country)
adminRouter.get(   "/anomalies",                       requirePermission("security","read"),  anomalies.listAnomalies);
adminRouter.post(  "/anomalies/:id/ack",               requirePermission("security","write"), anomalies.ackAnomaly);
adminRouter.post(  "/anomalies/bulk-ack",              requirePermission("security","write"), anomalies.bulkAckAnomalies);
adminRouter.post(  "/anomalies/scan",                  requirePermission("security","write"), anomalies.triggerScan);

// Incidents (status-page lifecycle)
adminRouter.get(   "/incidents",                       requirePermission("settings","read"),  incidents.listIncidents);
adminRouter.get(   "/incidents/:id",                   requirePermission("settings","read"),  incidents.getIncident);
adminRouter.post(  "/incidents",                       requirePermission("settings","write"), incidents.createIncident);
adminRouter.patch( "/incidents/:id",                   requirePermission("settings","write"), incidents.patchIncident);
adminRouter.post(  "/incidents/:id/updates",           requirePermission("settings","write"), incidents.appendUpdate);
adminRouter.post(  "/incidents/bulk-resolve",          requirePermission("settings","write"), incidents.bulkResolve);
adminRouter.post(  "/incidents/from-alert/:alertId",   requirePermission("settings","write"), incidents.declareFromAlert);
adminRouter.get(   "/incidents/:id/recap",             requirePermission("settings","read"),  incidents.getIncidentRecap);

// Maintenance windows
adminRouter.get(   "/maintenance",                     requirePermission("settings","read"),  maint.listMaintenance);
adminRouter.post(  "/maintenance",                     requirePermission("settings","write"), maint.createMaintenance);
adminRouter.post(  "/maintenance/:id/cancel",          requirePermission("settings","write"), maint.cancelMaintenance);
adminRouter.delete("/maintenance/:id",                 requirePermissionWithStepUp("settings","write"), maint.deleteMaintenance);

// SLA / RED metrics per endpoint
adminRouter.get(   "/sla/overview",                    requirePermission("settings","read"),  sla.getSlaOverview);
adminRouter.post(  "/sla/flush",                       requirePermission("settings","write"), sla.flushSla);

// OpenAPI spec (live introspection of the running router)
adminRouter.get(   "/openapi.json",                    requirePermission("settings","read"),  openApi.getOpenApi);

// Saved replies (canned moderation/support responses)
adminRouter.get(   "/saved-replies",                   requirePermission("moderation","read"), savedRep.listReplies);
adminRouter.post(  "/saved-replies",                   requirePermission("moderation","act"),  savedRep.createReply);
adminRouter.patch( "/saved-replies/:id",               requirePermission("moderation","act"),  savedRep.updateReply);
adminRouter.delete("/saved-replies/:id",               requirePermission("moderation","act"),  savedRep.deleteReply);
adminRouter.post(  "/saved-replies/:id/use",           requirePermission("moderation","read"), savedRep.markUsed);

// PII inventory — GDPR Article 30 records of processing
adminRouter.get(   "/pii",                             requirePermission("security","read"),  pii.listPii);
adminRouter.patch( "/pii/:id",                         requirePermission("security","write"), pii.updatePii);
adminRouter.post(  "/pii/reseed",                      requirePermissionWithStepUp("security","write"), pii.reseedPii);
adminRouter.get(   "/pii/export/ropa",                 requirePermission("security","read"),  pii.exportRopa);

// Approval workflows (two-person rule for high-risk actions)
adminRouter.get(   "/approvals",                       requirePermission("audit","read"),  approvals.listApprovals);
adminRouter.get(   "/approvals/:id",                   requirePermission("audit","read"),  approvals.getApproval);
adminRouter.post(  "/approvals/:id/review",            requirePermission("audit","read"),  approvals.reviewApproval);
adminRouter.post(  "/approvals/bulk-reject",           requirePermission("audit","read"),  approvals.bulkReject);

// OAuth 2.0 client registry
adminRouter.get(   "/oauth/clients",                       requirePermission("api_keys","read"),         oauthClients.listClients);
adminRouter.get(   "/oauth/clients/:id",                   requirePermission("api_keys","read"),         oauthClients.getClient);
adminRouter.post(  "/oauth/clients",                       requirePermissionWithStepUp("api_keys","write"), oauthClients.createClient);
adminRouter.patch( "/oauth/clients/:id",                   requirePermission("api_keys","write"),        oauthClients.updateClient);
adminRouter.post(  "/oauth/clients/:id/rotate",            requirePermissionWithStepUp("api_keys","write"), oauthClients.rotateSecret);
adminRouter.delete("/oauth/clients/:id",                   requirePermissionWithStepUp("api_keys","write"), oauthClients.revokeClient);
adminRouter.delete("/oauth/clients/:clientId/tokens/:tokenId", requirePermission("api_keys","write"),    oauthClients.revokeToken);

// SCIM 2.0 admin inspector — read-only status + recent provisioned users
adminRouter.get(   "/scim/status",                     requirePermission("api_keys","read"), scimAdmin.getScimStatus);

// SAML 2.0 SSO configuration
adminRouter.get(   "/saml/configs",                    requirePermission("security","read"),  samlCfg.listConfigs);
adminRouter.get(   "/saml/configs/:id",                requirePermission("security","read"),  samlCfg.getConfig);
adminRouter.post(  "/saml/configs",                    requirePermissionWithStepUp("security","write"), samlCfg.createConfig);
adminRouter.patch( "/saml/configs/:id",                requirePermissionWithStepUp("security","write"), samlCfg.updateConfig);
adminRouter.post(  "/saml/configs/:id/activate",       requirePermissionWithStepUp("security","write"), samlCfg.activateConfig);
adminRouter.post(  "/saml/deactivate",                 requirePermissionWithStepUp("security","write"), samlCfg.deactivateAll);
adminRouter.delete("/saml/configs/:id",                requirePermissionWithStepUp("security","write"), samlCfg.deleteConfig);
adminRouter.get(   "/saml/login-events",               requirePermission("security","read"),  samlCfg.listLoginEvents);
adminRouter.get(   "/saml/sp-urls",                    requirePermission("security","read"),  samlCfg.getSpMetadataUrl);

// FinOps — cost dashboard + per-endpoint rate config + budget
adminRouter.get(   "/cost/overview",                   requirePermission("settings","read"),  cost.getOverview);
adminRouter.get(   "/cost/rates",                      requirePermission("settings","read"),  cost.listRates);
adminRouter.put(   "/cost/rates",                      requirePermission("settings","write"), cost.upsertRate);
adminRouter.delete("/cost/rates/:id",                  requirePermission("settings","write"), cost.deleteRate);
adminRouter.get(   "/cost/budget",                     requirePermission("settings","read"),  cost.getBudget);
adminRouter.put(   "/cost/budget",                     requirePermission("settings","write"), cost.setBudget);

// DX — rate-limit overrides, API changelog, deprecations, captures
adminRouter.get(   "/dx/rate-limits",                  requirePermission("settings","read"),  dx.listRateLimits);
adminRouter.put(   "/dx/rate-limits",                  requirePermission("settings","write"), dx.upsertRateLimit);
adminRouter.delete("/dx/rate-limits/:id",              requirePermission("settings","write"), dx.deleteRateLimit);
adminRouter.get(   "/dx/changelog",                    requirePermission("settings","read"),  dx.listChangelog);
adminRouter.post(  "/dx/changelog",                    requirePermission("settings","write"), dx.createChangelog);
adminRouter.delete("/dx/changelog/:id",                requirePermission("settings","write"), dx.deleteChangelog);
adminRouter.get(   "/dx/deprecations",                 requirePermission("settings","read"),  dx.listDeprecations);
adminRouter.put(   "/dx/deprecations",                 requirePermission("settings","write"), dx.upsertDeprecation);
adminRouter.delete("/dx/deprecations/:id",             requirePermission("settings","write"), dx.deleteDeprecation);
adminRouter.get(   "/dx/captures",                     requirePermission("audit","read"),     dx.listCaptures);
adminRouter.delete("/dx/captures/:id",                 requirePermission("audit","read"),     dx.deleteCapture);

// Compliance — consent, RTBF queue, vendor register, KMS rotation
adminRouter.get(   "/compliance/consent",              requirePermission("security","read"),  compliance.listConsent);
adminRouter.get(   "/compliance/rtbf",                 requirePermission("security","read"),  compliance.listRtbf);
adminRouter.post(  "/compliance/rtbf",                 requirePermissionWithStepUp("dsr","delete"), compliance.createRtbf);
adminRouter.post(  "/compliance/rtbf/:id/review",      requirePermissionWithStepUp("dsr","delete"), compliance.reviewRtbf);
adminRouter.get(   "/compliance/vendors",              requirePermission("security","read"),  compliance.listVendors);
adminRouter.post(  "/compliance/vendors",              requirePermission("security","write"), compliance.upsertVendor);
adminRouter.put(   "/compliance/vendors/:id",          requirePermission("security","write"), compliance.upsertVendor);
adminRouter.delete("/compliance/vendors/:id",          requirePermission("security","write"), compliance.deleteVendor);
adminRouter.get(   "/compliance/kms",                  requirePermission("security","read"),  compliance.listKms);
adminRouter.put(   "/compliance/kms",                  requirePermissionWithStepUp("security","write"), compliance.upsertKms);
adminRouter.delete("/compliance/kms/:id",              requirePermissionWithStepUp("security","write"), compliance.deleteKms);

// AI Ops — LLM observability, prompt registry, eval results, RAG inventory
adminRouter.get(   "/ai/llm/overview",                 requirePermission("settings","read"),  aiOps.getLlmOverview);
adminRouter.get(   "/ai/prompts",                      requirePermission("settings","read"),  aiOps.listPrompts);
adminRouter.post(  "/ai/prompts",                      requirePermission("settings","write"), aiOps.createPromptVersion);
adminRouter.post(  "/ai/prompts/:id/activate",         requirePermission("settings","write"), aiOps.activatePromptVersion);
adminRouter.get(   "/ai/evals",                        requirePermission("settings","read"),  aiOps.listEvals);
adminRouter.post(  "/ai/evals",                        requirePermission("settings","write"), aiOps.createEval);
adminRouter.get(   "/ai/rag",                          requirePermission("settings","read"),  aiOps.listRag);
adminRouter.put(   "/ai/rag",                          requirePermission("settings","write"), aiOps.upsertRag);
adminRouter.delete("/ai/rag/:id",                      requirePermission("settings","write"), aiOps.deleteRag);

// Observability — SLO definitions + synthetic monitor schedules
adminRouter.get(   "/observability/slos",              requirePermission("settings","read"),  obs.listSlos);
adminRouter.put(   "/observability/slos",              requirePermission("settings","write"), obs.upsertSlo);
adminRouter.put(   "/observability/slos/:id",          requirePermission("settings","write"), obs.upsertSlo);
adminRouter.delete("/observability/slos/:id",          requirePermission("settings","write"), obs.deleteSlo);
adminRouter.get(   "/observability/monitors",          requirePermission("settings","read"),  obs.listMonitors);
adminRouter.put(   "/observability/monitors",          requirePermission("settings","write"), obs.upsertMonitor);
adminRouter.put(   "/observability/monitors/:id",      requirePermission("settings","write"), obs.upsertMonitor);
adminRouter.delete("/observability/monitors/:id",      requirePermission("settings","write"), obs.deleteMonitor);
adminRouter.post(  "/observability/monitors/:id/record", requirePermission("settings","write"), obs.recordMonitorOutcome);

// Security extras — IP allowlist, secrets vault, DR runbooks
adminRouter.get(   "/security/allowlist",              requirePermission("security","read"),  secX.listAllowlist);
adminRouter.post(  "/security/allowlist",              requirePermissionWithStepUp("security","write"), secX.createAllowlist);
adminRouter.delete("/security/allowlist/:id",          requirePermissionWithStepUp("security","write"), secX.deleteAllowlist);
adminRouter.get(   "/security/vault",                  requirePermission("security","read"),  secX.listVault);
adminRouter.put(   "/security/vault",                  requirePermissionWithStepUp("security","write"), secX.upsertVault);
adminRouter.delete("/security/vault/:id",              requirePermissionWithStepUp("security","write"), secX.deleteVault);
adminRouter.get(   "/security/runbooks",               requirePermission("security","read"),  secX.listRunbooks);
adminRouter.put(   "/security/runbooks",               requirePermission("security","write"), secX.upsertRunbook);
adminRouter.put(   "/security/runbooks/:id",           requirePermission("security","write"), secX.upsertRunbook);
adminRouter.delete("/security/runbooks/:id",           requirePermission("security","write"), secX.deleteRunbook);

// Trust Center editor — public consumer at GET /api/v1/trust
adminRouter.get(   "/trust/entries",                   requirePermission("settings","read"),  trust.listEntries);
adminRouter.put(   "/trust/entries",                   requirePermission("settings","write"), trust.upsertEntry);
adminRouter.put(   "/trust/entries/:id",               requirePermission("settings","write"), trust.upsertEntry);
adminRouter.delete("/trust/entries/:id",               requirePermission("settings","write"), trust.deleteEntry);

// Support tickets
adminRouter.get(   "/tickets",                         requirePermission("moderation","read"), tickets.listTickets);
adminRouter.get(   "/tickets/:id",                     requirePermission("moderation","read"), tickets.getTicket);
adminRouter.post(  "/tickets",                         requirePermission("moderation","act"),  tickets.createTicket);
adminRouter.patch( "/tickets/:id",                     requirePermission("moderation","act"),  tickets.updateTicket);
adminRouter.post(  "/tickets/:id/replies",             requirePermission("moderation","act"),  tickets.addReply);
adminRouter.post(  "/tickets/bulk",                    requirePermission("moderation","act"),  tickets.bulkAction);

// Distributed traces (self-hosted)
adminRouter.get(   "/traces",                          requirePermission("audit","read"), traces.listTraces);
adminRouter.get(   "/traces/:traceId",                 requirePermission("audit","read"), traces.getTrace);

// Log search (WARN+ persisted into LogEntry)
adminRouter.get(   "/logs",                            requirePermission("audit","read"), logs.listLogs);
adminRouter.post(  "/logs/flush",                      requirePermission("audit","read"), logs.forceFlush);

// Ticket integration webhooks (HMAC-signed outbound)
adminRouter.get(   "/tickets/webhooks/list",           requirePermission("webhooks","read"),  tHooks.listHooks);
adminRouter.post(  "/tickets/webhooks",                requirePermissionWithStepUp("webhooks","write"), tHooks.createHook);
adminRouter.patch( "/tickets/webhooks/:id",            requirePermission("webhooks","write"), tHooks.updateHook);
adminRouter.post(  "/tickets/webhooks/:id/rotate",     requirePermissionWithStepUp("webhooks","write"), tHooks.rotateHookSecret);
adminRouter.delete("/tickets/webhooks/:id",            requirePermission("webhooks","write"), tHooks.deleteHook);

// A/B experiments
adminRouter.get(   "/experiments",                     requirePermission("flags","read"),  exps.listExperiments);
adminRouter.post(  "/experiments",                     requirePermission("flags","write"), exps.createExperiment);
adminRouter.post(  "/experiments/:id/transition",      requirePermission("flags","write"), exps.transitionExperiment);
adminRouter.get(   "/experiments/:id/results",         requirePermission("flags","read"),  exps.getExperimentResults);
adminRouter.delete("/experiments/:id",                 requirePermissionWithStepUp("flags","write"), exps.deleteExperiment);

// On-call rotation + escalation
adminRouter.get(   "/oncall/schedules",                requirePermission("settings","read"),  onCall.listSchedules);
adminRouter.post(  "/oncall/schedules",                requirePermission("settings","write"), onCall.createSchedule);
adminRouter.post(  "/oncall/schedules/:id/rotation",   requirePermission("settings","write"), onCall.postRotation);
adminRouter.delete("/oncall/shifts/:id",               requirePermission("settings","write"), onCall.deleteShift);
adminRouter.get(   "/oncall/current",                  requirePermission("settings","read"),  onCall.getCurrent);
adminRouter.get(   "/oncall/policies",                 requirePermission("settings","read"),  onCall.listPolicies);
adminRouter.put(   "/oncall/policies",                 requirePermissionWithStepUp("settings","write"), onCall.upsertPolicy);

// Backup tracker
adminRouter.get(   "/backups",                         requirePermission("security","read"),  backups.listBackups);
adminRouter.post(  "/backups",                         requirePermission("security","write"), backups.recordBackup);
adminRouter.post(  "/backups/:id/verify",              requirePermission("security","write"), backups.verifyBackup);
adminRouter.delete("/backups/:id",                     requirePermissionWithStepUp("security","write"), backups.deleteBackup);

// Internal user notes (admin-only CRM-lite per user)
adminRouter.get(   "/users/:userId/notes",             requirePermission("users","read"),   userNotes.listForUser);
adminRouter.post(  "/users/:userId/notes",             requirePermission("users","update"), userNotes.createNote);
adminRouter.patch( "/user-notes/:id",                  requirePermission("users","update"), userNotes.updateNote);
adminRouter.delete("/user-notes/:id",                  requirePermission("users","update"), userNotes.deleteNote);

// Custom dashboards — composable widget grids
adminRouter.get(   "/dashboards/sources",              requirePermission("settings","read"),  dashboards.listSources);
adminRouter.get(   "/dashboards",                      requirePermission("settings","read"),  dashboards.listDashboards);
adminRouter.get(   "/dashboards/:id",                  requirePermission("settings","read"),  dashboards.getDashboard);
adminRouter.post(  "/dashboards",                      requirePermission("settings","write"), dashboards.createDashboard);
adminRouter.patch( "/dashboards/:id",                  requirePermission("settings","write"), dashboards.updateDashboard);
adminRouter.delete("/dashboards/:id",                  requirePermission("settings","write"), dashboards.deleteDashboard);
adminRouter.post(  "/dashboards/:id/widgets",          requirePermission("settings","write"), dashboards.upsertWidget);
adminRouter.put(   "/dashboards/:id/widgets/:widgetId",requirePermission("settings","write"), dashboards.upsertWidget);
adminRouter.delete("/dashboards/widgets/:widgetId",    requirePermission("settings","write"), dashboards.deleteWidget);

// Bulk exports — CSV/JSON of safelisted resources
adminRouter.get(   "/export/sources",                  requirePermission("audit","read"),   exportsCtrl.listExportSources);
adminRouter.get(   "/export/:resource",                requirePermission("audit","export"), exportsCtrl.exportResource);

// Notification router — channels + rules + manual test dispatch
adminRouter.get(   "/notify/channels",                 requirePermission("settings","read"),  notifyCh.listChannels);
adminRouter.post(  "/notify/channels",                 requirePermission("settings","write"), notifyCh.createChannel);
adminRouter.patch( "/notify/channels/:id",             requirePermission("settings","write"), notifyCh.updateChannel);
adminRouter.delete("/notify/channels/:id",             requirePermissionWithStepUp("settings","write"), notifyCh.deleteChannel);
adminRouter.get(   "/notify/rules",                    requirePermission("settings","read"),  notifyCh.listRules);
adminRouter.post(  "/notify/rules",                    requirePermission("settings","write"), notifyCh.createRule);
adminRouter.patch( "/notify/rules/:id",                requirePermission("settings","write"), notifyCh.updateRule);
adminRouter.delete("/notify/rules/:id",                requirePermissionWithStepUp("settings","write"), notifyCh.deleteRule);
adminRouter.post(  "/notify/test",                     requirePermission("settings","write"), notifyCh.testDispatch);

// Composite platform-health view
adminRouter.get(   "/platform-health/overview",        requirePermission("settings","read"),  platformH.getPlatformHealthOverview);

// Admin activity inbox
adminRouter.get(   "/inbox",                           requirePermission("settings","read"),  inbox.getInbox);

// Saved searches per resource
adminRouter.get(   "/saved-searches/:resource",        requirePermission("settings","read"),  savedSrch.listForResource);
adminRouter.post(  "/saved-searches",                  requirePermission("settings","read"),  savedSrch.createSearch);
adminRouter.delete("/saved-searches/:id",              requirePermission("settings","read"),  savedSrch.deleteSearch);

// Vendor integration framework (Datadog/Zendesk/Slack/Linear/Stripe Connect)
adminRouter.get(   "/integrations/providers",          requirePermission("settings","read"),  integ.listProviders);
adminRouter.get(   "/integrations",                    requirePermission("settings","read"),  integ.listIntegrations);
adminRouter.post(  "/integrations",                    requirePermissionWithStepUp("settings","write"), integ.createIntegration);
adminRouter.patch( "/integrations/:id",                requirePermission("settings","write"), integ.updateIntegration);
adminRouter.delete("/integrations/:id",                requirePermissionWithStepUp("settings","write"), integ.deleteIntegration);
adminRouter.post(  "/integrations/:provider/sync",     requirePermission("settings","write"), integ.syncProvider);

