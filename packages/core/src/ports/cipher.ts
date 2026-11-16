/**
 * Encryption of secrets kept in the deploy repository.
 */

export interface SecretCipher {
  decrypt(document: string): Promise<string>;
  /** Encrypts `plain` unless `current` already decrypts to it, so an unchanged secret keeps its bytes. */
  encryptIfChanged(current: string | null, plain: string): Promise<{ changed: boolean; document: string }>;
  /** A secret that stays the same for this key: fingerprints values without revealing them. */
  revisionKey: string;
}
