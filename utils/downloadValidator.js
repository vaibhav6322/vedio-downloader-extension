const BLOCKED_MANIFEST_EXTENSIONS = [".m3u8", ".mpd"];
const ALLOWED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".ogv"
]);

export function validateDownloadUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { ok: false, error: "Download URL is empty." };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return { ok: false, error: "Download URL is invalid." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Only HTTP(S) URLs are supported." };
  }

  const pathname = (parsed.pathname || "").toLowerCase();
  if (BLOCKED_MANIFEST_EXTENSIONS.some((ext) => pathname.endsWith(ext))) {
    return { ok: false, error: "Streaming manifests are not downloadable." };
  }

  const extension = getFileExtension(parsed.pathname);
  if (!extension || !ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      error: "Only direct video files are supported (.mp4, .webm, .mov, .m4v, .ogv)."
    };
  }

  return { ok: true, extension, normalizedUrl: parsed.href };
}

export function getFileExtension(pathname = "") {
  const tail = pathname.split("/").pop() || "";
  const dotIndex = tail.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === tail.length - 1) {
    return "";
  }

  return tail.slice(dotIndex).toLowerCase();
}
