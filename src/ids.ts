import { randomBytes, randomInt } from "node:crypto";

/** No vowels (avoids accidental words), no 0/1/l/o/i (avoids transcription errors over chat). */
const ALPHABET = "bcdfghjkmnpqrstvwxyz23456789";
export const ID_LENGTH = 8;
export const ID_PATTERN = new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`);

export function newId(): string {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Per-bundle bypass token. 128 bits; appears in URLs, so hex keeps it copy-pasteable. */
export function newSecret(): string {
  return randomBytes(16).toString("hex");
}
