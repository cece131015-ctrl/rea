import type { TextRange } from "./htmlUrlReferences.js";

/** One URL written in CSS, with the exact source token span to replace. */
export interface CssUrlReference {
  /**
   * `url-token`: `url(...)` without quotes, the span covers the whole token.
   * `string`: a quoted string inside `url(` or after `@import`, the span
   * covers the string including its quotes.
   */
  readonly kind: "url-token" | "string";
  /** The URL after CSS escape decoding, with surrounding whitespace removed. */
  readonly url: string;
  readonly range: TextRange;
}

const isNewline = (character: string | undefined): boolean =>
  character === "\n" || character === "\r" || character === "\f";
const isWhitespace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || isNewline(character);
const isHexDigit = (character: string | undefined): boolean =>
  character !== undefined && /^[0-9A-Fa-f]$/u.test(character);
const isNameStart = (character: string | undefined): boolean =>
  character !== undefined &&
  (/^[A-Za-z_]$/u.test(character) || character.charCodeAt(0) >= 0x80);
const isNameCharacter = (character: string | undefined): boolean =>
  isNameStart(character) ||
  character === "-" ||
  (character !== undefined && /^[0-9]$/u.test(character));
const isNonPrintable = (character: string | undefined): boolean => {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    code <= 0x08 ||
    code === 0x0b ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
};

// CSS Syntax 3, 4.3.8: a backslash starts an escape unless a newline follows.
const startsEscape = (text: string, index: number): boolean =>
  text[index] === "\\" && !isNewline(text[index + 1]);

/** Consume an escape after its backslash; returns the code point and next index. */
const consumeEscape = (
  text: string,
  index: number,
): { readonly value: string; readonly next: number } => {
  if (index >= text.length) return { value: "�", next: index };
  if (!isHexDigit(text[index]))
    return { value: text[index] ?? "", next: index + 1 };
  let end = index;
  while (end < text.length && end - index < 6 && isHexDigit(text[end]))
    end += 1;
  const code = Number.parseInt(text.slice(index, end), 16);
  if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
  else if (isWhitespace(text[end])) end += 1;
  const valid =
    code !== 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return { value: valid ? String.fromCodePoint(code) : "�", next: end };
};

// Image functions whose plain string arguments are URLs (CSS Images 4).
const IMAGE_SET_FUNCTIONS = new Set(["image-set", "-webkit-image-set"]);

/**
 * Tokenize enough of CSS Syntax Level 3 to find every URL reference: comments,
 * strings and escapes are honored so URL-like text inside them is ignored.
 * Bad strings and bad URLs are skipped, not reported as references.
 */
export const cssUrlReferences = (text: string): CssUrlReference[] => {
  const references: CssUrlReference[] = [];
  // A string token is a URL when it follows `url(` or `@import`, or is a
  // direct argument of an image-set function.
  let expectUrlString = false;
  let expectImport = false;
  // Lowercase names of the open functions; "" for a plain parenthesis block.
  const functions: string[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const token = consumeString(text, index, character);
      if (
        !token.bad &&
        (expectUrlString ||
          expectImport ||
          IMAGE_SET_FUNCTIONS.has(functions.at(-1) ?? ""))
      )
        references.push({
          kind: "string",
          url: token.value.trim(),
          range: { start: index, end: token.next },
        });
      expectUrlString = false;
      expectImport = false;
      index = token.next;
      continue;
    }
    // A hash token such as `#url` is a name, never a function.
    if (
      character === "#" &&
      (isNameCharacter(text[index + 1]) || startsEscape(text, index + 1))
    ) {
      index = consumeName(text, index + 1).next;
      expectUrlString = false;
      expectImport = false;
      continue;
    }
    if (character === "@" && startsIdentifier(text, index + 1)) {
      const name = consumeName(text, index + 1);
      expectImport = name.value.toLowerCase() === "import";
      expectUrlString = false;
      index = name.next;
      continue;
    }
    if (startsIdentifier(text, index)) {
      const start = index;
      const name = consumeName(text, index);
      index = name.next;
      const functionName = name.value.toLowerCase();
      if (functionName === "url" && text[index] === "(") {
        let next = index + 1;
        while (isWhitespace(text[next])) next += 1;
        if (text[next] === '"' || text[next] === "'") {
          functions.push(functionName);
          expectUrlString = true;
          expectImport = false;
          index = next;
          continue;
        }
        const token = consumeUrl(text, next);
        if (!token.bad)
          references.push({
            kind: "url-token",
            url: token.value,
            range: { start, end: token.next },
          });
        index = token.next;
      } else if (text[index] === "(") {
        functions.push(functionName);
        index += 1;
      }
      expectUrlString = false;
      expectImport = false;
      continue;
    }
    if (character === "(") functions.push("");
    else if (character === ")") functions.pop();
    if (startsEscape(text, index)) index = consumeEscape(text, index + 1).next;
    else index += 1;
    expectUrlString = false;
    expectImport = false;
  }
  return references;
};

const startsIdentifier = (text: string, index: number): boolean => {
  const first = text[index];
  if (first === "-")
    return (
      isNameStart(text[index + 1]) ||
      text[index + 1] === "-" ||
      startsEscape(text, index + 1)
    );
  return isNameStart(first) || startsEscape(text, index);
};

const consumeName = (
  text: string,
  index: number,
): { readonly value: string; readonly next: number } => {
  let value = "";
  let next = index;
  while (next < text.length) {
    if (isNameCharacter(text[next])) {
      value += text[next];
      next += 1;
    } else if (startsEscape(text, next)) {
      const escape = consumeEscape(text, next + 1);
      value += escape.value;
      next = escape.next;
    } else break;
  }
  return { value, next };
};

const consumeString = (
  text: string,
  index: number,
  quote: string,
): { readonly value: string; readonly next: number; readonly bad: boolean } => {
  let value = "";
  let next = index + 1;
  while (next < text.length) {
    const character = text[next];
    if (character === quote) return { value, next: next + 1, bad: false };
    // An unescaped newline ends a bad string before the newline.
    if (isNewline(character)) return { value, next, bad: true };
    if (character === "\\") {
      if (next + 1 >= text.length) {
        next += 1;
        continue;
      }
      if (isNewline(text[next + 1])) {
        next += text[next + 1] === "\r" && text[next + 2] === "\n" ? 3 : 2;
        continue;
      }
      const escape = consumeEscape(text, next + 1);
      value += escape.value;
      next = escape.next;
      continue;
    }
    value += character;
    next += 1;
  }
  // EOF inside a string still yields a string token.
  return { value, next, bad: false };
};

const consumeUrl = (
  text: string,
  index: number,
): { readonly value: string; readonly next: number; readonly bad: boolean } => {
  let value = "";
  let next = index;
  while (next < text.length) {
    const character = text[next];
    if (character === ")") return { value, next: next + 1, bad: false };
    if (isWhitespace(character)) {
      while (isWhitespace(text[next])) next += 1;
      if (next >= text.length) return { value, next, bad: false };
      if (text[next] === ")") return { value, next: next + 1, bad: false };
      return badUrl(text, next);
    }
    if (
      character === '"' ||
      character === "'" ||
      character === "(" ||
      isNonPrintable(character)
    )
      return badUrl(text, next);
    if (character === "\\") {
      if (!startsEscape(text, next)) return badUrl(text, next);
      const escape = consumeEscape(text, next + 1);
      value += escape.value;
      next = escape.next;
      continue;
    }
    value += character;
    next += 1;
  }
  return { value, next, bad: false };
};

// Consume the remnants of a bad URL up to and including its closing paren.
const badUrl = (
  text: string,
  index: number,
): { readonly value: string; readonly next: number; readonly bad: true } => {
  let next = index;
  while (next < text.length && text[next] !== ")") {
    if (startsEscape(text, next)) next = consumeEscape(text, next + 1).next;
    else next += 1;
  }
  return { value: "", next: Math.min(next + 1, text.length), bad: true };
};

/** Write a URL as a double-quoted CSS string. */
export const cssString = (url: string): string =>
  `"${url.replace(/[\\"\n\r\f]/gu, (character) =>
    character === "\\" || character === '"'
      ? `\\${character}`
      : `\\${character.charCodeAt(0).toString(16)} `,
  )}"`;
