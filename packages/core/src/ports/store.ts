/**
 * Object storage: keys and bytes, for what outlives the cluster (build logs
 * after their pods are cleaned up). One S3-compatible implementation covers
 * S3, R2 and MinIO.
 */

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Null when there is no such object. */
  get(key: string): Promise<Uint8Array | null>;
  /** Keys under a prefix, in key order. */
  list(prefix: string): Promise<string[]>;
  /** Removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/** Keys stardust writes: path segments of safe characters, no `..`, no leading slash. */
export const OBJECT_KEY = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]{1,1024}$/;
