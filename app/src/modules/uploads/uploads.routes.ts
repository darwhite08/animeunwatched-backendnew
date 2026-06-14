import { Router, raw } from "express";
import multer from "multer";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./uploads.controller";

export const uploadsRouter = Router();

// DM media goes through server-side processing → multer memory storage, 10MB
// hard cap (images), per-user 20/hour (spec §3). Voice is further size-checked
// in the service.
const dmUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Encrypted media is opaque ciphertext (no server-side resize), so the cap is
// higher to allow for AES-GCM overhead + larger originals.
const dmEncUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

uploadsRouter.post("/avatar",     requireAuth, ctrl.avatar);
uploadsRouter.post("/post-image", requireAuth, ctrl.postImage);
uploadsRouter.post("/voice",      requireAuth, ctrl.voice);
uploadsRouter.post("/shot-video", requireAuth, ctrl.shotVideo);
uploadsRouter.post("/story",      requireAuth, ctrl.story);
uploadsRouter.post(
  "/dm",
  requireAuth,
  rateLimit(20, 60 * 60_000, { perUser: true, bucket: "dm-upload" }),
  dmUpload.single("file"),
  ctrl.dmMedia,
);
uploadsRouter.post(
  "/dm-encrypted",
  requireAuth,
  rateLimit(20, 60 * 60_000, { perUser: true, bucket: "dm-upload-enc" }),
  dmEncUpload.single("file"),
  ctrl.dmEncryptedMedia,
);

// Server-side fallback when the browser can't PUT directly to S3.
// Accepts images and short videos (shots), buffered then sent to S3 with our creds.
uploadsRouter.post(
  "/proxy",
  requireAuth,
  raw({ type: ["image/*", "video/*"], limit: "100mb" }),
  ctrl.uploadProxy,
);
