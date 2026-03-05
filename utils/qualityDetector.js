const QUALITY_HEIGHT_PATTERNS = [
  { pattern: /\b4320p?\b/i, height: 4320, label: "4320p" },
  { pattern: /\b8k\b/i, height: 4320, label: "4320p" },
  { pattern: /\b2160p?\b/i, height: 2160, label: "2160p" },
  { pattern: /\b4k\b/i, height: 2160, label: "2160p" },
  { pattern: /\b1440p?\b/i, height: 1440, label: "1440p" },
  { pattern: /\b1080p?\b/i, height: 1080, label: "1080p" },
  { pattern: /\b720p?\b/i, height: 720, label: "720p" },
  { pattern: /\b540p?\b/i, height: 540, label: "540p" },
  { pattern: /\b480p?\b/i, height: 480, label: "480p" },
  { pattern: /\b360p?\b/i, height: 360, label: "360p" },
  { pattern: /\b240p?\b/i, height: 240, label: "240p" }
];

const UNKNOWN_QUALITY = Object.freeze({
  label: "Unknown Quality",
  height: 0
});

export function detectQualityFromUrl(url, sourceType = "") {
  const text = `${safeUrlText(url)} ${sourceType || ""}`.toLowerCase();

  for (const candidate of QUALITY_HEIGHT_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return {
        label: candidate.label,
        height: candidate.height
      };
    }
  }

  return { ...UNKNOWN_QUALITY };
}

export function normalizeQuality(quality, fallbackUrl = "", fallbackType = "") {
  if (quality && typeof quality.label === "string" && typeof quality.height === "number") {
    const normalizedHeight = Number.isFinite(quality.height) ? Math.max(0, quality.height) : 0;
    const normalizedLabel = quality.label.trim() || (normalizedHeight > 0 ? `${normalizedHeight}p` : "");
    return {
      label: normalizedLabel || UNKNOWN_QUALITY.label,
      height: normalizedHeight
    };
  }

  return detectQualityFromUrl(fallbackUrl, fallbackType);
}

export function compareQualityDesc(a, b) {
  const left = normalizeQuality(a);
  const right = normalizeQuality(b);
  return right.height - left.height;
}

function safeUrlText(url) {
  if (typeof url !== "string" || !url.trim()) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname} ${parsed.search}`;
  } catch (error) {
    return url;
  }
}
