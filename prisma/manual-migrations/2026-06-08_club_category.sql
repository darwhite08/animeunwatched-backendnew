-- Club category (cosmetic grouping shown in browse + create). ADDITIVE.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "category" TEXT;
