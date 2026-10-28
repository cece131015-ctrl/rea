import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A half-open UTF-16 code-unit range in the parsed text. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** One attribute value as the browser decodes it, with its exact source span. */
export interface HtmlAttributeValue {
  readonly element: string;
  readonly attribute: string;
  /** Character references decoded, as parse5 reports it. */
  readonly value: string;
  /** The value span, excluding quotes; empty for a value-less attribute. */
  readonly valueRange: TextRange;
  /** The quote that delimits the value in source, or null when unquoted. */
  readonly quote: '"' | "'" | null;
  /** The attribute is written without `=` and a value. */
  readonly valueless: boolean;
}

/**
 * A URL-bearing attribute, CSS text, or base declaration in one HTML
 * document. Base declarations come only from the document tree: a `<base>`
 * inside template content never sets the document base URL.
 */
export type HtmlUrlReference =
  | (HtmlAttributeValue & {
      readonly kind: "url" | "srcset" | "base";
      /** Exact source spans of sibling attributes, keyed by lowercase name. */
      readonly siblingAttributes: ReadonlyMap<string, TextRange>;
    })
  | (HtmlAttributeValue & { readonly kind: "style-attribute" })
  | {
      readonly kind: "style-element";
      readonly element: "style";
      /** Raw text: style element content holds no character references. */
      readonly value: string;
      readonly valueRange: TextRange;
    };

// Attributes whose value is one URL, by element in the HTML namespace.
const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  area: ["href"],
  link: ["href"],
  script: ["src"],
  img: ["src"],
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  audio: ["src"],
  video: ["src", "poster"],
  source: ["src"],
  track: ["src"],
  input: ["src"],
  object: ["data"],
  body: ["background"],
  table: ["background"],
  td: ["background"],
  th: ["background"],
};
const SRCSET_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ["srcset"],
  source: ["srcset"],
  link: ["imagesrcset"],
};
const SVG_URL_ELEMENTS = new Set(["image", "use", "feImage", "a", "script"]);

/**
 * Extract every URL-bearing attribute, srcset, base href, style attribute and
 * style element of one HTML document, with exact source value spans so a
 * caller can splice replacements without re-serializing the document.
 */
export const htmlUrlReferences = (text: string): HtmlUrlReference[] => {
  const references: HtmlUrlReference[] = [];
  // Reconstructing active formatting elements (an <a> or <font> left open
  // across <p> or <li>) clones an element with its start tag's location; each
  // source start tag is interpreted once.
  const seenStartTags = new Set<number>();
  const pending: {
    readonly node: DefaultTreeAdapterTypes.Node;
    readonly inTemplate: boolean;
  }[] = [
    {
      node: parse(text, { sourceCodeLocationInfo: true }),
      inTemplate: false,
    },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const { node, inTemplate } = entry;
    if (defaultTreeAdapter.isElementNode(node)) {
      const start = node.sourceCodeLocation?.startOffset;
      if (start !== undefined && !seenStartTags.has(start)) {
        seenStartTags.add(start);
        references.push(...elementReferences(text, node, inTemplate));
      }
    }
    // Template content is a separate fragment; it still loads when used.
    if ("content" in node)
      pending.push({ node: node.content, inTemplate: true });
    if ("childNodes" in node)
      for (const child of node.childNodes.toReversed())
        pending.push({ node: child, inTemplate });
  }
  return references.sort((left, right) =>
    left.valueRange.start === right.valueRange.start
      ? 0
      : left.valueRange.start < right.valueRange.start
        ? -1
        : 1,
  );
};

const elementReferences = (
  text: string,
  node: DefaultTreeAdapterTypes.Element,
  inTemplate: boolean,
): HtmlUrlReference[] => {
  const location = node.sourceCodeLocation;
  if (location === undefined || location === null) return [];
  const attributeLocations = location.attrs;
  const siblings = new Map<string, TextRange>();
  for (const [name, span] of Object.entries(attributeLocations ?? {}))
    siblings.set(name, { start: span.startOffset, end: span.endOffset });
  const references: HtmlUrlReference[] = [];
  const attribute = (sourceName: string) => {
    const span = attributeLocations?.[sourceName];
    const decoded = node.attrs.find(
      (candidate) =>
        (candidate.prefix === undefined || candidate.prefix === ""
          ? candidate.name
          : `${candidate.prefix}:${candidate.name}`) === sourceName,
    );
    if (span === undefined || decoded === undefined) return undefined;
    return {
      element: node.tagName,
      attribute: sourceName,
      value: decoded.value,
      ...attributeValueSpan(text, span.startOffset, span.endOffset),
    };
  };
  const push = (
    kind: "url" | "srcset" | "base",
    value: HtmlAttributeValue | undefined,
  ) => {
    if (value !== undefined)
      references.push({ ...value, kind, siblingAttributes: siblings });
  };
  if (node.namespaceURI === HTML_NAMESPACE) {
    if (node.tagName === "base" && !inTemplate) push("base", attribute("href"));
    for (const name of URL_ATTRIBUTES[node.tagName] ?? [])
      push("url", attribute(name));
    for (const name of SRCSET_ATTRIBUTES[node.tagName] ?? [])
      push("srcset", attribute(name));
    if (node.tagName === "style") {
      const body = elementText(node);
      if (body !== undefined)
        references.push({ kind: "style-element", element: "style", ...body });
    }
  } else if (
    node.namespaceURI === SVG_NAMESPACE &&
    SVG_URL_ELEMENTS.has(node.tagName)
  ) {
    push("url", attribute("href"));
    push("url", attribute("xlink:href"));
  }
  const style = attribute("style");
  if (style !== undefined)
    references.push({ ...style, kind: "style-attribute" });
  return references;
};

/** Locate the value inside one `name[=value]` attribute span. */
const attributeValueSpan = (
  text: string,
  start: number,
  end: number,
): Pick<HtmlAttributeValue, "valueRange" | "quote" | "valueless"> => {
  const source = text.slice(start, end);
  const equals = source.indexOf("=");
  if (equals < 0)
    return { valueRange: { start: end, end }, quote: null, valueless: true };
  let index = equals + 1;
  while (index < source.length && /[\t\n\f\r ]/u.test(source[index] ?? ""))
    index += 1;
  const quote = source[index];
  if (quote === '"' || quote === "'")
    return {
      valueRange: {
        start: start + index + 1,
        end:
          source.endsWith(quote) && source.length - 1 > index ? end - 1 : end,
      },
      quote,
      valueless: false,
    };
  return {
    valueRange: { start: start + index, end },
    quote: null,
    valueless: false,
  };
};

/** The raw text span between a style element's tags. */
const elementText = (
  node: DefaultTreeAdapterTypes.Element,
): { readonly value: string; readonly valueRange: TextRange } | undefined => {
  const texts = node.childNodes.filter((child) =>
    defaultTreeAdapter.isTextNode(child),
  );
  const first = texts[0]?.sourceCodeLocation;
  const last = texts.at(-1)?.sourceCodeLocation;
  if (first == null || last == null) return undefined;
  return {
    value: texts.map((child) => child.value).join(""),
    valueRange: { start: first.startOffset, end: last.endOffset },
  };
};

/** One candidate URL inside a srcset value, as a range of the decoded value. */
export interface SrcsetCandidate {
  readonly url: string;
  readonly range: TextRange;
}

/**
 * Split a srcset value into candidate URLs following the HTML "parse a srcset
 * attribute" algorithm; descriptors are kept in place by the caller.
 */
export const srcsetCandidates = (value: string): SrcsetCandidate[] => {
  const candidates: SrcsetCandidate[] = [];
  const whitespace = /[\t\n\f\r ]/u;
  let index = 0;
  while (index < value.length) {
    while (
      index < value.length &&
      (whitespace.test(value[index] ?? "") || value[index] === ",")
    )
      index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !whitespace.test(value[index] ?? ""))
      index += 1;
    let end = index;
    const endsWithComma = value[end - 1] === ",";
    while (end > start && value[end - 1] === ",") end -= 1;
    if (end > start)
      candidates.push({ url: value.slice(start, end), range: { start, end } });
    if (endsWithComma) continue;
    // Skip descriptors up to the next comma outside parentheses.
    let depth = 0;
    while (index < value.length) {
      const character = value[index];
      if (character === "(") depth += 1;
      else if (character === ")" && depth > 0) depth -= 1;
      else if (character === "," && depth === 0) break;
      index += 1;
    }
  }
  return candidates;
};
