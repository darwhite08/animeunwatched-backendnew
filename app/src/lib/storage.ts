/**
 * Object-storage client. Supports two backends, picked at runtime by env:
 *
 *   1. AWS S3 (preferred when running on AWS — uses instance-role creds)
 *      S3_BUCKET, S3_REGION, S3_PUBLIC_URL
 *
 *   2. Cloudflare R2 (S3-compatible) — for non-AWS deploys
 *      R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
 *
 * Returns presigned PUT URLs so the browser uploads directly to storage
 * without proxying bytes through this server.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { env } from "../config/env";
import { configError } from "./errors";

type Backend = {
  client:    S3Client
  bucket:    string
  publicUrl: string
}

let cached: Backend | null = null

function getBackend(): Backend {
  if (cached) return cached

  // AWS SDK v3 auto-injects x-amz-checksum-* + x-amz-sdk-checksum-algorithm
  // query params into the presigned URL, which a browser PUT can't satisfy
  // without also sending the matching headers. Switching both knobs to
  // WHEN_REQUIRED disables that pre-computation — the browser does a clean
  // PUT with just Content-Type and the signature stays valid.
  const checksumOff = {
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
  }

  // Prefer AWS S3 if configured
  if (env.S3_BUCKET) {
    const publicUrl = (env.S3_PUBLIC_URL || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`).replace(/\/$/, "")
    cached = {
      // No explicit credentials — picks up from the AWS env / IMDS / App Runner instance role
      client: new S3Client({ region: env.S3_REGION, ...checksumOff }),
      bucket: env.S3_BUCKET,
      publicUrl,
    }
    return cached
  }

  // Fall back to R2
  if (env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
    cached = {
      client: new S3Client({
        region:   "auto",
        endpoint: env.R2_ENDPOINT,
        credentials: {
          accessKeyId:     env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        ...checksumOff,
      }),
      bucket:    env.R2_BUCKET,
      publicUrl: env.R2_PUBLIC_URL.replace(/\/$/, ""),
    }
    return cached
  }

  throw configError("Object storage not configured — set S3_BUCKET or R2_*")
}

export type UploadIntent = {
  uploadUrl:   string
  publicUrl:   string
  key:         string
  expiresIn:   number
  contentType: string
}

/**
 * Generate a presigned PUT URL for the given key, scoped to images.
 * Caller must PUT the bytes to uploadUrl with the same Content-Type header
 * within `expiresIn` seconds, then save `publicUrl` to their model.
 */
function makeKey(opts: { scope: "avatar" | "post" | "club" | "voice" | "shot" | "story" | "dm"; userId: string; ext: string }): string {
  const rand = randomBytes(8).toString("hex")
  const safeExt = (opts.ext || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5)
  return `${opts.scope}/${opts.userId}/${Date.now()}-${rand}.${safeExt}`
}

/**
 * Server-side upload — for the fallback flow when the browser can't reach
 * S3 directly (extension blockers, strict CSP, corporate proxy). Accepts
 * raw bytes, returns the same shape as presigned URL upload.
 */
export async function uploadImageBuffer(opts: {
  userId:      string
  scope:       "avatar" | "post" | "club" | "voice" | "shot" | "story" | "dm"
  contentType: string
  ext:         string
  body:        Buffer
}): Promise<{ publicUrl: string; key: string }> {
  const b = getBackend()
  const key = makeKey({ scope: opts.scope, userId: opts.userId, ext: opts.ext })
  await b.client.send(new PutObjectCommand({
    Bucket:       b.bucket,
    Key:          key,
    Body:         opts.body,
    ContentType:  opts.contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }))
  return { publicUrl: `${b.publicUrl}/${key}`, key }
}

export async function presignImageUpload(opts: {
  userId:      string
  scope:       "avatar" | "post" | "club" | "voice" | "shot" | "story" | "dm"
  contentType: string
  ext:         string
}): Promise<UploadIntent> {
  const b = getBackend()
  const key = makeKey({ scope: opts.scope, userId: opts.userId, ext: opts.ext })

  const cmd = new PutObjectCommand({
    Bucket:       b.bucket,
    Key:          key,
    ContentType:  opts.contentType,
    CacheControl: "public, max-age=31536000, immutable",
  })

  const expiresIn = 300 // 5 minutes
  const uploadUrl = await getSignedUrl(b.client, cmd, { expiresIn })
  const publicUrl = `${b.publicUrl}/${key}`

  return { uploadUrl, publicUrl, key, expiresIn, contentType: opts.contentType }
}
