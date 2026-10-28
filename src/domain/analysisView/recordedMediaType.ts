const MEDIA_TYPE_ESSENCE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

const JSON_LIKE_TEXT = new Set(["text/plain", "text/markdown"]);

/** Lowercase type/subtype without parameters; malformed essences are unknown. */
export const mediaTypeEssence = (reported: string): string | null => {
  const separator = reported.indexOf(";");
  let start = 0;
  let end = separator < 0 ? reported.length : separator;
  // HTTP OWS is SP/HTAB. Scan from both ends so malformed internal runs of
  // whitespace cannot cause repeated trailing-regex searches.
  while (start < end && (reported[start] === " " || reported[start] === "\t"))
    start += 1;
  while (
    end > start &&
    (reported[end - 1] === " " || reported[end - 1] === "\t")
  )
    end -= 1;
  const essence = reported.slice(start, end);
  // Validate ASCII tokens before case folding can turn Unicode into ASCII.
  return MEDIA_TYPE_ESSENCE.test(essence) ? essence.toLowerCase() : null;
};

/** `application/json` or `application/*+json`; a `+json` suffix on another type is not JSON here. */
export const isJson = (essence: string | null): boolean =>
  essence === "application/json" ||
  (essence !== null &&
    essence.startsWith("application/") &&
    essence.endsWith("+json"));

/** JSON, `+json`, `text/plain` or `text/markdown`: the content types a replay parses as JSON. */
export const isJsonLike = (essence: string | null): boolean =>
  isJson(essence) || (essence !== null && JSON_LIKE_TEXT.has(essence));

const PARAMETER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const isOws = (character: string | undefined): boolean =>
  character === " " || character === "\t";

/**
 * One parameter of a reported media type (RFC 9110), such as `charset`, or
 * undefined when absent or malformed. Names match case-insensitively, values
 * keep their case, quoted values are unescaped and the first occurrence wins.
 */
export const mediaTypeParameter = (
  reported: string,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  let index = reported.indexOf(";");
  if (index < 0) return undefined;
  while (index < reported.length) {
    index += 1;
    while (isOws(reported[index])) index += 1;
    const nameStart = index;
    while (
      index < reported.length &&
      reported[index] !== "=" &&
      reported[index] !== ";"
    )
      index += 1;
    const parameter = reported.slice(nameStart, index);
    if (reported[index] !== "=") continue;
    index += 1;
    let value = "";
    let quoted = false;
    if (reported[index] === '"') {
      quoted = true;
      index += 1;
      while (index < reported.length && reported[index] !== '"') {
        if (reported[index] === "\\" && index + 1 < reported.length) index += 1;
        value += reported[index];
        index += 1;
      }
      while (index < reported.length && reported[index] !== ";") index += 1;
    } else {
      const valueStart = index;
      while (index < reported.length && reported[index] !== ";") index += 1;
      let valueEnd = index;
      while (valueEnd > valueStart && isOws(reported[valueEnd - 1]))
        valueEnd -= 1;
      value = reported.slice(valueStart, valueEnd);
    }
    if (
      PARAMETER_TOKEN.test(parameter) &&
      (quoted || PARAMETER_TOKEN.test(value)) &&
      parameter.toLowerCase() === wanted
    )
      return value;
  }
  return undefined;
};
