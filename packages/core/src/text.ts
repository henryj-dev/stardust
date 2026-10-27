/** Whether text holds a control character (U+0000–U+001F or U+007F), which could break out of a line. */
export function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
