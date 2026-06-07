import { presignImageUpload, type UploadIntent } from "../../lib/storage";

function extFromContentType(ct: string): string {
  if (ct === "image/jpeg") return "jpg";
  if (ct === "image/png")  return "png";
  if (ct === "image/webp") return "webp";
  if (ct === "image/gif")  return "gif";
  if (ct === "audio/m4a" || ct === "audio/mp4") return "m4a";
  if (ct === "audio/mpeg") return "mp3";
  if (ct === "audio/aac")  return "aac";
  if (ct === "audio/webm") return "webm";
  if (ct === "audio/ogg")  return "ogg";
  if (ct === "video/mp4")       return "mp4";
  if (ct === "video/webm")      return "webm";
  if (ct === "video/quicktime") return "mov";
  if (ct === "video/3gpp")      return "3gp";
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

export async function presignShotVideo(opts: {
  userId: string;
  contentType: string;
}): Promise<UploadIntent> {
  return presignImageUpload({
    userId: opts.userId,
    scope: "shot",
    contentType: opts.contentType,
    ext: extFromContentType(opts.contentType),
  });
}

export async function presignStory(opts: {
  userId: string;
  contentType: string;
}): Promise<UploadIntent> {
  return presignImageUpload({
    userId: opts.userId,
    scope: "story",
    contentType: opts.contentType,
    ext: extFromContentType(opts.contentType),
  });
}

export async function presignVoiceMessage(opts: {
  userId: string;
  contentType: string;
}): Promise<UploadIntent> {
  return presignImageUpload({
    userId: opts.userId,
    scope: "voice",
    contentType: opts.contentType,
    ext: extFromContentType(opts.contentType),
  });
}
