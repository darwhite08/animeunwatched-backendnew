import { presignImageUpload, type UploadIntent } from "../../lib/storage";

function extFromContentType(ct: string): string {
  if (ct === "image/jpeg") return "jpg";
  if (ct === "image/png")  return "png";
  if (ct === "image/webp") return "webp";
  if (ct === "image/gif")  return "gif";
  return "bin";
}

export async function presignAvatar(opts: {
  userId: string;
  contentType: string;
}): Promise<UploadIntent> {
  return presignImageUpload({
    userId: opts.userId,
    scope: "avatar",
    contentType: opts.contentType,
    ext: extFromContentType(opts.contentType),
  });
}

export async function presignPostImage(opts: {
  userId: string;
  contentType: string;
}): Promise<UploadIntent> {
  return presignImageUpload({
    userId: opts.userId,
    scope: "post",
    contentType: opts.contentType,
    ext: extFromContentType(opts.contentType),
  });
}
