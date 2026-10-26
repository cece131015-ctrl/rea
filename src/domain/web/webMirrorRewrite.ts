import { posix } from "node:path";

import { cssString, cssUrlReferences } from "./cssUrlReferences.js";
import {
  htmlUrlReferences,
  srcsetCandidates,
  type TextRange,
} from "./htmlUrlReferences.js";

/** Counts of one view file's reference edits. */
export interface RewriteCounts {
  readonly rewritten: number;
  readonly unresolved: number;
  readonly removedAttributes: number;
}

/** The rewritten text of one view file and what changed. */
export interface RewrittenText extends RewriteCounts {
  readonly text: string;
}

/**
 * Map an absolute URL without fragment to the output-root relative path of
 * its local copy, or undefined when the capture has no bytes for it.
 */
export type MirrorLookup = (urlWithoutFragment: string) => string | undefined;

interface RewriteContext {
  /** Output-root relative path of the view file being written. */
  readonly fromPath: string;
  readonly lookup: MirrorLookup;
}

type ReferenceOutcome =
  | { readonly kind: "local"; readonly value: string }
  | { readonly kind: "absolute"; readonly value: string }
  | { readonly kind: "unchanged" };

// HTML URL attributes strip leading and trailing ASCII whitespace.
const trimAsciiWhitespace = (value: string): string =>
  value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");

const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * Resolve one reference. Captured HTTP(S) URLs become paths relative to the
 * view file; uncaptured relative URLs become absolute so offline links never
 * silently point at missing local files. Non-HTTP and unparseable references
 * are left exactly as written, and so are empty and fragment-only references
 * that stay in the same document (`sameDocument`).
 */
const resolveReference = (
  raw: string,
  base: URL,
  context: RewriteContext,
  sameDocument: boolean,
): ReferenceOutcome => {
  const reference = trimAsciiWhitespace(raw);
  if (sameDocument && (reference === "" || reference.startsWith("#")))
    return { kind: "unchanged" };
  let url: URL;
  try {
    url = new URL(reference, base);
  } catch {
    return { kind: "unchanged" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { kind: "unchanged" };
  const fragment = url.hash;
  url.hash = "";
  const target = context.lookup(url.href);
  if (target === undefined) {
    const absolute = `${url.href}${fragment}`;
    return absolute === reference
      ? { kind: "unchanged" }
      : { kind: "absolute", value: absolute };
  }
  const relative = posix.relative(posix.dirname(context.fromPath), target);
  return {
    kind: "local",
    value: `${encodePath(relative === "" ? posix.basename(target) : relative)}${fragment}`,
  };
};

const withoutFragment = (url: URL): string => {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
};

interface Edit extends TextRange {
  readonly replacement: string;
}

const applyEdits = (text: string, edits: readonly Edit[]): string => {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  let output = "";
  let position = 0;
  for (const edit of ordered) {
    if (edit.start < position)
      throw new RangeError("Mirror rewrite edits overlap");
    output += text.slice(position, edit.start) + edit.replacement;
    position = edit.end;
  }
  return output + text.slice(position);
};

/** Rewrite url() and @import references in one CSS text. */
export const rewriteCss = (
  text: string,
  base: URL,
  context: RewriteContext,
): RewrittenText => {
  let rewritten = 0;
  let unresolved = 0;
  const edits: Edit[] = [];
  for (const reference of cssUrlReferences(text)) {
    // Fragment-only CSS URLs always refer to the current document.
    const outcome = resolveReference(reference.url, base, context, true);
    if (outcome.kind === "unchanged") continue;
    if (outcome.kind === "local") rewritten += 1;
    else unresolved += 1;
    edits.push({
      ...reference.range,
      replacement:
        reference.kind === "url-token"
          ? `url(${cssString(outcome.value)})`
          : cssString(outcome.value),
    });
  }
  return {
    text: applyEdits(text, edits),
    rewritten,
    unresolved,
    removedAttributes: 0,
  };
};

const encodeAttribute = (value: string, quote: '"' | "'" | null): string => {
  const delimiter = quote ?? '"';
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll(delimiter, delimiter === '"' ? "&quot;" : "&#39;");
  return quote === null ? `"${escaped}"` : escaped;
};

// Subresource integrity no longer matches a rewritten view, and file://
// documents cannot satisfy CORS for crossorigin requests.
const LOCAL_INCOMPATIBLE_ATTRIBUTES = ["integrity", "crossorigin"];

/**
 * Rewrite one HTML document by splicing exact attribute and style spans.
 * The document is never re-serialized, so untouched bytes are preserved.
 */
export const rewriteHtml = (
  text: string,
  documentUrl: URL,
  context: RewriteContext,
): RewrittenText => {
  const references = htmlUrlReferences(text);
  // The first base element with an href attribute sets the document base,
  // even when its value is empty; an unparseable value leaves the document URL.
  const declaredBase = references.find(({ kind }) => kind === "base");
  let base = documentUrl;
  if (declaredBase !== undefined)
    try {
      base = new URL(trimAsciiWhitespace(declaredBase.value), documentUrl);
    } catch {
      base = documentUrl;
    }
  // The view's base is its own file, so empty and fragment-only references
  // keep their meaning only when the original base was the document itself.
  const sameDocument = withoutFragment(base) === withoutFragment(documentUrl);
  let rewritten = 0;
  let unresolved = 0;
  const edits: Edit[] = [];
  const removed = new Set<number>();
  const count = (outcome: ReferenceOutcome): void => {
    if (outcome.kind === "local") rewritten += 1;
    else if (outcome.kind === "absolute") unresolved += 1;
  };
  for (const reference of references) {
    if (reference.kind === "base") {
      if (reference === declaredBase)
        edits.push({
          ...reference.valueRange,
          replacement: encodeAttribute(
            encodePath(posix.basename(context.fromPath)),
            reference.quote,
          ),
        });
      continue;
    }
    if (reference.kind === "style-element") {
      const css = rewriteCss(reference.value, base, context);
      rewritten += css.rewritten;
      unresolved += css.unresolved;
      if (css.text !== reference.value)
        edits.push({ ...reference.valueRange, replacement: css.text });
      continue;
    }
    if (reference.kind === "style-attribute") {
      const css = rewriteCss(reference.value, base, context);
      rewritten += css.rewritten;
      unresolved += css.unresolved;
      if (css.text !== reference.value)
        edits.push({
          ...reference.valueRange,
          replacement: encodeAttribute(css.text, reference.quote),
        });
      continue;
    }
    let value = reference.value;
    let local = false;
    if (reference.kind === "srcset") {
      let changed = "";
      let position = 0;
      for (const candidate of srcsetCandidates(reference.value)) {
        const outcome = resolveReference(
          candidate.url,
          base,
          context,
          sameDocument,
        );
        count(outcome);
        if (outcome.kind === "unchanged") continue;
        local ||= outcome.kind === "local";
        changed +=
          reference.value.slice(position, candidate.range.start) +
          outcome.value;
        position = candidate.range.end;
      }
      value = changed + reference.value.slice(position);
    } else {
      const outcome = resolveReference(
        reference.value,
        base,
        context,
        sameDocument,
      );
      count(outcome);
      if (outcome.kind !== "unchanged") value = outcome.value;
      local = outcome.kind === "local";
    }
    if (value === reference.value) continue;
    edits.push({
      ...reference.valueRange,
      replacement: encodeAttribute(value, reference.quote),
    });
    if (!local) continue;
    for (const name of LOCAL_INCOMPATIBLE_ATTRIBUTES) {
      const span = reference.siblingAttributes.get(name);
      if (span === undefined || removed.has(span.start)) continue;
      removed.add(span.start);
      edits.push({ ...span, replacement: "" });
    }
  }
  return {
    text: applyEdits(text, edits),
    rewritten,
    unresolved,
    removedAttributes: removed.size,
  };
};
