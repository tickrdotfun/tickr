/**
 * What counts as a renderable image for a token. Two shapes reach us: a link somebody pasted, and a raster data
 * URI written on-chain by the create flow. SVG data URIs are deliberately excluded: they are markup from an
 * untrusted launcher, and keeping them out means no surface has to reason about that.
 */
const RASTER_DATA = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const IPFS = /^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/;
export const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

export function isRenderableImage(src?: string): boolean {
  if (!src) return false;
  return /^https?:\/\//i.test(src) || RASTER_DATA.test(src) || IPFS.test(src);
}

/** The URL a browser can load: an ipfs:// URI goes through a public gateway, everything else is itself. */
export function resolveImage(src: string): string {
  const m = IPFS.exec(src);
  return m ? `${IPFS_GATEWAY}${m[1]}${m[2] ?? ""}` : src;
}
