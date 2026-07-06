import { MEDIA_ASSETS } from './manifest.generated';

function logicalPath(url: string): string {
  return url.replace(/^\/+/, '');
}

export function assetUrl(url: string): string {
  // Absolute non-path URLs (editor-imported blob:/data: models, cross-origin
  // http(s) assets) pass through untouched; the manifest only maps site paths.
  if (/^(blob:|data:|https?:)/.test(url)) return url;
  const logical = logicalPath(url);
  if (import.meta.env.DEV) return `/${logical}`;
  return MEDIA_ASSETS[logical] ?? `/${logical}`;
}
