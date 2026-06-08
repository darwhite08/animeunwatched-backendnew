-- Multi-photo posts: Post.imageUrls gallery. ADDITIVE. Fixes feed 500 (schema drift).
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "imageUrls" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill the gallery from the legacy single image so existing posts keep theirs.
UPDATE "Post" SET "imageUrls" = ARRAY["imageUrl"]
WHERE "imageUrl" IS NOT NULL AND ("imageUrls" IS NULL OR cardinality("imageUrls") = 0);
