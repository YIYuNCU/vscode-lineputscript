const replaceAllLiteral = (value: string, search: string, replacement: string): string =>
  value.split(search).join(replacement);

export function decodeLpsText(value: string | undefined | null): string {
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

export function decodeLpsTextForPreview(value: string | undefined | null): string {
  let text = value ?? "";
  for (let index = 0; index < 8; index++) {
    const decoded = decodeLpsText(text);
    if (decoded === text) {
      return decoded;
    }
    text = decoded;
  }
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
  { label: "/n", detail: "Escaped newline" },
  { label: "/tab", detail: "Escaped tab" },
  { label: "/com", detail: "Escaped comma" },
  { label: "/!", detail: "Escaped slash" },
  { label: "/|", detail: "Escaped pipe" },
  { label: "/equ", detail: "Escaped equals sign, accepted by decoder" },
  { label: "/r", detail: "Escaped carriage return" }
];
