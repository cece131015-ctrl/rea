const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const MEDIA_TYPE_ESSENCE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

/** A parsed HTTP media type; names are ASCII-lowercased, values verbatim. */
export interface MediaType {
  readonly essence: string;
  readonly parameters: ReadonlyMap<string, string>;
}

const isOws = (character: string | undefined): boolean =>
  character === " " || character === "\t";

/**
 * Parse one reported Content-Type value (RFC 9110 media-type). Returns null
 * when the type/subtype is not a valid token pair. Malformed parameters are
 * skipped; the first occurrence of a repeated parameter name wins.
 */
export const parseMediaType = (reported: string): MediaType | null => {
  const separator = reported.indexOf(";");
  let start = 0;
  let end = separator < 0 ? reported.length : separator;
  // HTTP OWS is SP/HTAB. Scan from both ends so malformed internal runs of
  // whitespace cannot cause repeated trailing-regex searches.
  while (start < end && isOws(reported[start])) start += 1;
  while (end > start && isOws(reported[end - 1])) end -= 1;
  const essence = reported.slice(start, end);
  // Validate ASCII tokens before case folding can turn Unicode into ASCII.
  if (!MEDIA_TYPE_ESSENCE.test(essence)) return null;
  return {
    essence: essence.toLowerCase(),
    parameters:
      separator < 0 ? new Map() : parseParameters(reported.slice(separator)),
  };
};

/** The lowercase type/subtype of a reported media type, or null when invalid. */
export const mediaTypeEssence = (reported: string): string | null =>
  parseMediaType(reported)?.essence ?? null;

/** JSON media types: application/json and every +json structured suffix. */
export const isJsonMediaType = (
  reported: string | null | undefined,
): boolean => {
  const essence =
    reported === null || reported === undefined
      ? null
      : mediaTypeEssence(reported);
  return essence === "application/json" || essence?.endsWith("+json") === true;
};

// `text` starts at a ";" and holds `*( OWS ";" OWS parameter )`.
const parseParameters = (text: string): Map<string, string> => {
  const parameters = new Map<string, string>();
  let index = 0;
  while (index < text.length) {
    index += 1;
    while (isOws(text[index])) index += 1;
    const nameStart = index;
    while (index < text.length && text[index] !== "=" && text[index] !== ";")
      index += 1;
    const name = text.slice(nameStart, index);
    if (text[index] !== "=") continue;
    index += 1;
    let value = "";
    let quoted = false;
    if (text[index] === '"') {
      quoted = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length) index += 1;
        value += text[index];
        index += 1;
      }
      while (index < text.length && text[index] !== ";") index += 1;
    } else {
      const valueStart = index;
      while (index < text.length && text[index] !== ";") index += 1;
      let valueEnd = index;
      while (valueEnd > valueStart && isOws(text[valueEnd - 1])) valueEnd -= 1;
      value = text.slice(valueStart, valueEnd);
    }
    const key = name.toLowerCase();
    if (
      TOKEN.test(name) &&
      (quoted || TOKEN.test(value)) &&
      !parameters.has(key)
    )
      parameters.set(key, value);
  }
  return parameters;
};
