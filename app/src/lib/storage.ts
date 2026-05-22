/**
 * Cloudflare R2 client (S3-compatible).
 * Returns presigned PUT URLs so the mobile/web client uploads directly to R2
 * without proxying bytes through this server.
 *
 * Required env:
 *   R2_ENDPOINT             https://<accountid>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET
 *   R2_PUBLIC_URL           public CDN URL for the bucket (custom domain or pub-*.r2.dev)
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { env } from "../config/env";
import { configError } from "./errors";

let client: S3Client | null = null;
function getClient(): S3Client {
  if (client) return client;
  if (
    !env.R2_ENDPOINT ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET
  ) {
    throw configError("R2 storage is not configured");
  }
  client = new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

export type UploadIntent = {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresIn: number;
  contentType: string;
};

/**
 * Generates a presigned PUT URL for the given key, scoped to images.
 * Caller must PUT the bytes to uploadUrl with the same Content-Type header
 * within `expiresIn` seconds, then save `publicUrl` to their model.
 */
export async function presignImageUpload(opts: {
  userId: string;
  scope: "avatar" | "post" | "club" | "voice";
  contentType: string;
  ext: string;
}): Promise<UploadIntent> {
  const c = getClient();
  const rand = randomBytes(8).toString("hex");
  const safeExt = (opts.ext || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5);
  const key = `${opts.scope}/${opts.userId}/${Date.now()}-${rand}.${safeExt}`;

  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: opts.contentType,
    CacheControl: "public, max-age=31536000, immutable",
  });

  const expiresIn = 300; // 5 minutes
  const uploadUrl = await getSignedUrl(c, cmd, { expiresIn });
  const publicBase = env.R2_PUBLIC_URL.replace(/\/$/, "");
  const publicUrl = `${publicBase}/${key}`;

  return { uploadUrl, publicUrl, key, expiresIn, contentType: opts.contentType };
}
