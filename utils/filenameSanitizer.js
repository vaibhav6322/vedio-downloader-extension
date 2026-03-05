import { getFileExtension } from "./downloadValidator.js";

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export function inferDownloadFilename({ url, pageTitle = "", candidateIndex = 1, timestamp = Date.now() }) {
  const fromUrl = inferFilenameFromUrl(url);
  if (fromUrl) {
    return fromUrl;
  }

  const extension = getFileExtensionFromUrl(url) || ".mp4";
  const safeTitle = sanitizeFilename(pageTitle);
  if (safeTitle) {
    return `${safeTitle}-video-${Math.max(1, candidateIndex)}${extension}`;
  }

  return `video_${timestamp}${extension}`;
}

export function sanitizeFilename(name) {
  if (typeof name !== "string") {
    return "";
  }

  let sanitized = name
    .replace(INVALID_FILENAME_CHARS, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!sanitized) {
    return "";
  }

  if (sanitized.length > 120) {
    sanitized = sanitized.slice(0, 120).trim();
  }

  if (RESERVED_WINDOWS_NAMES.has(sanitized.toLowerCase())) {
    sanitized = `${sanitized}_file`;
  }

  return sanitized;
}

function inferFilenameFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return "";
  }

  const tail = parsed.pathname.split("/").pop();
  if (!tail) {
    return "";
  }

  let decodedTail = tail;
  try {
    decodedTail = decodeURIComponent(tail);
  } catch (error) {
    decodedTail = tail;
  }

  const extension = getFileExtension(decodedTail);
  if (!extension) {
    return "";
  }

  const baseName = decodedTail.slice(0, -extension.length);
  const safeBaseName = sanitizeFilename(baseName);
  if (!safeBaseName) {
    return "";
  }

  return `${safeBaseName}${extension}`;
}

function getFileExtensionFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return getFileExtension(parsed.pathname);
  } catch (error) {
    return "";
  }
}
