/** Long-edge cap for client-side prepare. Keep in lockstep with
 *  TRANSFORM_MAX_DIMENSION in packages/api/src/lib/images.ts (4096).
 *  Do not import that module — it pulls sharp + server env. */
export const IMAGE_MAX_DIMENSION = 4096;

/** Client-side default matching ASSET_UPLOAD_MAX_BYTES's Zod default
 *  in packages/env/src/vars/server.ts. Changing the env var in
 *  production also requires changing this constant. No VITE_ mirror. */
export const ASSET_UPLOAD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
