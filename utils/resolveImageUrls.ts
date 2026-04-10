import safeUrl from "@reactory/server-core/utils/url/safeUrl";

type AIImage = { b64_json?: string; url?: string; mimeType?: string };

/**
 * Resolves relative CDN image URLs to fully-qualified URLs using CDN_ROOT.
 *
 * Stored image URLs follow the pattern `/cdn/profiles/...`.  Since
 * CDN_ROOT already contains the `/cdn` segment (e.g. `http://host/cdn`),
 * the leading `/cdn/` is stripped before joining.
 *
 * URLs that are already absolute (http/https) are returned unchanged.
 */
const resolveImageUrls = (images?: AIImage[]): AIImage[] | undefined => {
  if (!images || images.length === 0) return images;
  const { CDN_ROOT = "http://localhost:4000/cdn" } = process.env;
  return images.map((img) => {
    if (!img.url || img.url.startsWith("http://") || img.url.startsWith("https://")) {
      return img;
    }
    const cdnRelative = img.url.replace(/^\/cdn\//, "");
    return { ...img, url: safeUrl([CDN_ROOT, cdnRelative]) };
  });
};

export default resolveImageUrls;
