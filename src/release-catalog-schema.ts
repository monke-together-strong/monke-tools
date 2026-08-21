import { array, boolean, looseObject, string, url } from "zod";
import type { output } from "zod";

export const ReleaseCatalogAssetSchema = looseObject({
  browser_download_url: url(),
  digest: string().nullable().optional(),
  name: string()
});

export const ReleaseCatalogEntrySchema = looseObject({
  assets: array(ReleaseCatalogAssetSchema),
  draft: boolean(),
  prerelease: boolean(),
  tag_name: string(),
  target_commitish: string()
});

export const ReleaseCatalogPageSchema = array(ReleaseCatalogEntrySchema);

export type ReleaseCatalogAsset = output<typeof ReleaseCatalogAssetSchema>;
export type ReleaseCatalogEntry = output<typeof ReleaseCatalogEntrySchema>;
