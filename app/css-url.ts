/**
 * Serializes a CMS-controlled URL for a quoted CSS url() token.
 * Parentheses, quotes, backslashes, and controls are percent-encoded so a
 * valid object name cannot terminate the CSS function or inject declarations.
 */
export function cssUrl(value: string) {
  const encoded = encodeURI(value.trim()).replace(
    /[()"'\\\n\r\f]/gu,
    (character) =>
      `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `url("${encoded}")`;
}
