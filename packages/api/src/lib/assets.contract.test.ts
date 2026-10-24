import type { AssetMeta, AssetMetaRow, toAssetMeta } from "./assets";

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

export type AssetMetaContract = Assert<IsExact<ReturnType<typeof toAssetMeta>, AssetMeta>>;
export type AssetMetaRowKeysContract = Assert<
  IsExact<
    keyof AssetMetaRow,
    | "id"
    | "storageKey"
    | "mimeType"
    | "size"
    | "visibility"
    | "ownerId"
    | "width"
    | "height"
    | "blurhash"
    | "status"
    | "metadataState"
  >
>;
