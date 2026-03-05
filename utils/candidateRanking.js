import { detectQualityFromUrl, normalizeQuality } from "./qualityDetector.js";

const EXTENSION_WEIGHTS = Object.freeze({
  mp4: 60,
  webm: 55,
  mov: 40,
  m4v: 35,
  ogv: 30
});

const MAIN_CONTENT_HINTS = ["video", "media", "content", "download", "asset", "playback"];

export function rankCandidates(candidates) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];

  return safeCandidates
    .map((candidate, index) => scoreCandidateGroup(candidate, index))
    .sort((a, b) => {
      if (b.ranking.score !== a.ranking.score) {
        return b.ranking.score - a.ranking.score;
      }
      return a.ranking.originalIndex - b.ranking.originalIndex;
    })
    .map((item, sortedIndex) => ({
      ...item,
      ranking: {
        ...item.ranking,
        rank: sortedIndex + 1
      }
    }));
}

function scoreCandidateGroup(candidate, originalIndex) {
  const sortedVariants = sortVariantsByQuality(candidate);
  const bestVariant = sortedVariants[0] || null;
  const bestUrl = typeof bestVariant?.url === "string" ? bestVariant.url : "";
  const extension = extractExtension(bestUrl);
  const extensionScore = EXTENSION_WEIGHTS[extension] || 5;

  const bestHeight = normalizeQuality(bestVariant?.quality, bestUrl, bestVariant?.type).height;
  const qualityScore = Math.min(120, bestHeight / 12);

  const domIndex =
    typeof candidate?.elementIndex === "number" && candidate.elementIndex >= 0
      ? candidate.elementIndex
      : originalIndex;
  const earlyDomScore = Math.max(0, 30 - domIndex);

  const hintScore = MAIN_CONTENT_HINTS.some((hint) => bestUrl.toLowerCase().includes(hint)) ? 12 : 0;
  const variantBonus = Math.min(20, sortedVariants.length * 3);
  const score = extensionScore + qualityScore + earlyDomScore + hintScore + variantBonus;

  return {
    ...candidate,
    url: bestVariant?.url || candidate?.url || "",
    normalizedUrl: bestVariant?.normalizedUrl || candidate?.normalizedUrl || "",
    variants: sortedVariants,
    ranking: {
      score,
      rank: 0,
      originalIndex,
      bestQualityLabel: normalizeQuality(bestVariant?.quality, bestUrl, bestVariant?.type).label,
      bestQualityHeight: bestHeight
    }
  };
}

function sortVariantsByQuality(candidate) {
  const sourceVariants = Array.isArray(candidate?.variants)
    ? candidate.variants
    : buildFallbackVariants(candidate);

  return sourceVariants
    .map((variant, index) => normalizeVariant(variant, candidate, index))
    .sort((a, b) => {
      const qualityDelta = b.quality.height - a.quality.height;
      if (qualityDelta !== 0) {
        return qualityDelta;
      }

      const extDelta = (EXTENSION_WEIGHTS[extractExtension(b.url)] || 0) - (EXTENSION_WEIGHTS[extractExtension(a.url)] || 0);
      if (extDelta !== 0) {
        return extDelta;
      }

      return a.variantOrder - b.variantOrder;
    });
}

function buildFallbackVariants(candidate) {
  const url = typeof candidate?.url === "string" ? candidate.url : "";
  if (!url) {
    return [];
  }

  return [
    {
      id: `${candidate?.id || "video"}_v1`,
      url,
      normalizedUrl: candidate?.normalizedUrl || "",
      quality: detectQualityFromUrl(url),
      type: "",
      variantOrder: 0
    }
  ];
}

function normalizeVariant(variant, candidate, index) {
  const url = typeof variant?.url === "string" ? variant.url : "";
  const quality = normalizeQuality(variant?.quality, url, variant?.type || "");

  return {
    ...variant,
    id: typeof variant?.id === "string" && variant.id ? variant.id : `${candidate?.id || "video"}_v${index + 1}`,
    quality,
    variantOrder:
      typeof variant?.variantOrder === "number" && Number.isFinite(variant.variantOrder)
        ? variant.variantOrder
        : index
  };
}

function extractExtension(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : "";
  } catch (error) {
    return "";
  }
}
