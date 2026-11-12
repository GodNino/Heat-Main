// trial_ends_at and is_demo arrive with migration 034, organization_id with 035, demo_expires_at with 037; older databases simply leave them out.
export type Restaurant = { id: string; name: string; owner_id: string; trial_ends_at?: string | null; is_demo?: boolean; organization_id?: string | null; demo_expires_at?: string | null };
export type MenuItem = {
  id: string;
  restaurant_id: string;
  name: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  category?: string;
  content_type?: "food" | "cocktails" | "wine";
  price_label?: string | null;
  price?: number | null;
  fire_minutes?: number | null;
  table_setting?: string | null;
  observations?: string | null;
  details?: Record<string, string> | null;
  photo_path: string | null;
  photo_url?: string;
  updated_at?: string;
};
export function listFromText(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
export function validatePhoto(
  file: Pick<File, "size" | "type">,
): string | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return "Choose a JPG, PNG, or WebP photo.";
  if (!file.size) return "This photo is empty. Choose another file.";
  if (file.size > 5 * 1024 * 1024) return "Choose a photo smaller than 5 MB.";
  return null;
}

// Dish videos (069): a short phone video explaining the card. MP4, MOV or WebM, up to 100 MB and
// 10 minutes; the bucket enforces the same size and types.
export const VIDEO_TYPES: Record<string, string> = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"};
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 600;
export function validateVideo(file: Pick<File, "size" | "type">, seconds?: number): string | null {
  if (!VIDEO_TYPES[file.type]) return "Choose an MP4, MOV or WebM video.";
  if (!file.size) return "This video is empty. Choose another file.";
  if (file.size > MAX_VIDEO_BYTES) return "Choose a video smaller than 100 MB. A minute or two at 720p is plenty.";
  if (seconds !== undefined && seconds > MAX_VIDEO_SECONDS) return "Keep the video under 10 minutes.";
  return null;
}
// Where a card's video lives: the restaurant's folder, then the card, then a fresh name so a new
// upload never serves the old file from a cache.
export function videoPath(restaurantId: string, itemId: string, type: string, stamp = Date.now()) {
  return `${restaurantId}/${itemId}/${stamp}.${VIDEO_TYPES[type] ?? "mp4"}`;
}

export function expandCrossContamination(value: string): string {
  return value.replace(/\bCC\b/gi, "cross-contamination");
}
