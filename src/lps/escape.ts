const replaceAllLiteral = (value: string, search: string, replacement: string): string =>
  value.split(search).join(replacement);

/**
 * Decoder used for everything the extension shows or exports.
 * It follows `Sub.TextDeReplace` except that `/n` is never turned into a newline: a newline would break
 * the one-line-per-record structure of the data, and the C# decoder also swallows the front of words
 * such as `/null` (newline + "ull"). `/n` therefore stays exactly as written; every other escape is decoded.
 */
export function decodeLpsText(value: string | undefined | null): string {
  let text = value ?? "";
  text = replaceAllLiteral(text, "/stop", ":|");
  text = replaceAllLiteral(text, "/equ", "=");
  text = replaceAllLiteral(text, "/tab", "\t");
  text = replaceAllLiteral(text, "/r", "\r");
  text = replaceAllLiteral(text, "/id", "#");
  text = replaceAllLiteral(text, "/com", ",");
  text = replaceAllLiteral(text, "/!", "/");
  text = replaceAllLiteral(text, "/|", "|");
  return text;
}

/**
 * Same steps and order as `Sub.TextDeReplace` in the C# library, including `/n` -> newline.
 * Only used to compare against the C# output (see test/tools/diff-fuzz.js).
 */
export function decodeLpsTextLikeCSharp(value: string | undefined | null): string {
  let text = value ?? "";
  text = replaceAllLiteral(text, "/stop", ":|");
  text = replaceAllLiteral(text, "/equ", "=");
  text = replaceAllLiteral(text, "/tab", "\t");
  text = replaceAllLiteral(text, "/n", "\n");
  text = replaceAllLiteral(text, "/r", "\r");
  text = replaceAllLiteral(text, "/id", "#");
  text = replaceAllLiteral(text, "/com", ",");
  text = replaceAllLiteral(text, "/!", "/");
  text = replaceAllLiteral(text, "/|", "|");
  return text;
}

export function hasInvalidRawLpsValue(value: string): boolean {
  return value.includes(":|");
}

export function encodeLpsText(value: string | undefined | null): string {
  let text = value ?? "";
  text = replaceAllLiteral(text, "|", "/|");
  text = replaceAllLiteral(text, "/", "/!");
  text = replaceAllLiteral(text, ":|", "/stop");
  text = replaceAllLiteral(text, "\t", "/tab");
  text = replaceAllLiteral(text, "\n", "/n");
  text = replaceAllLiteral(text, "\r", "/r");
  text = replaceAllLiteral(text, "#", "/id");
  text = replaceAllLiteral(text, ",", "/com");
  return text;
}

export const escapeCompletions = [
  { label: "/stop", detail: "Escaped :|" },
  { label: "/id", detail: "Escaped #" },
  { label: "/n", detail: "Escaped newline (kept as /n when decoding)" },
  { label: "/tab", detail: "Escaped tab" },
  { label: "/com", detail: "Escaped comma" },
  { label: "/!", detail: "Escaped slash" },
  { label: "/|", detail: "Escaped pipe" },
  { label: "/equ", detail: "Escaped equals sign, accepted by decoder" },
  { label: "/r", detail: "Escaped carriage return" }
];
