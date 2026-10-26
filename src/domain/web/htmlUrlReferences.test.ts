import { describe, expect, it } from "vitest";

import { htmlUrlReferences, srcsetCandidates } from "./htmlUrlReferences.js";

describe("htmlUrlReferences", () => {
  it("reports decoded values with exact quoted and unquoted value spans", () => {
    const html = `<a href="x?a=1&amp;b=2">x</a><img src=logo.png alt=''><link href='s.css' rel=stylesheet>`;
    const references = htmlUrlReferences(html);
    expect(
      references.map((reference) => [
        reference.kind,
        reference.element,
        reference.value,
        html.slice(reference.valueRange.start, reference.valueRange.end),
        "quote" in reference ? reference.quote : null,
      ]),
    ).toEqual([
      ["url", "a", "x?a=1&b=2", "x?a=1&amp;b=2", '"'],
      ["url", "img", "logo.png", "logo.png", null],
      ["url", "link", "s.css", "s.css", "'"],
    ]);
  });

  it("covers base, srcset, style attributes, style elements, svg and templates", () => {
    const html = `<base href="/root/"><style>.a{b:url(c.png)}</style><img srcset="a.png 1x, b.png 2x"><div style="background:url(d.png)"></div><svg><image xlink:href="e.svg"/><use href="#i"/></svg><template><img src="f.png"></template>`;
    expect(
      htmlUrlReferences(html).map(({ kind, element, value }) => [
        kind,
        element,
        value,
      ]),
    ).toEqual([
      ["base", "base", "/root/"],
      ["style-element", "style", ".a{b:url(c.png)}"],
      ["srcset", "img", "a.png 1x, b.png 2x"],
      ["style-attribute", "div", "background:url(d.png)"],
      ["url", "image", "e.svg"],
      ["url", "use", "#i"],
      ["url", "img", "f.png"],
    ]);
  });

  it("reports each source attribute once when parse5 reconstructs formatting elements", () => {
    for (const html of [
      `<p><a href="/about">About<p>More</a>`,
      `<ul><li><a href="/docs/">Docs</li><li>Other</li></ul>`,
      `<p><font style="background:url(/bg.png)">x<p>y`,
    ])
      expect(
        htmlUrlReferences(html).map(({ kind, valueRange }) => [
          kind,
          html.slice(valueRange.start, valueRange.end),
        ]),
      ).toHaveLength(1);
  });

  it("never reports a base element inside template content", () => {
    const html = `<template><base href="https://other.test/"></template><base href=""><img src="a.png">`;
    expect(
      htmlUrlReferences(html).map(({ kind, value }) => [kind, value]),
    ).toEqual([
      ["base", ""],
      ["url", "a.png"],
    ]);
  });

  it("names sibling attribute spans for later removal", () => {
    const html = `<script src="a.js" integrity="sha256-x" crossorigin></script>`;
    const [reference] = htmlUrlReferences(html);
    const span =
      reference !== undefined && "siblingAttributes" in reference
        ? reference.siblingAttributes.get("integrity")
        : undefined;
    expect(span && html.slice(span.start, span.end)).toBe(
      'integrity="sha256-x"',
    );
  });
});

describe("srcsetCandidates", () => {
  it("splits candidates as HTML does, without touching descriptors", () => {
    const value = " a.png 1x,b,c.png 2x ,  d(e).png 100w";
    expect(
      srcsetCandidates(value).map(({ url, range }) => [
        url,
        value.slice(range.start, range.end),
      ]),
    ).toEqual([
      ["a.png", "a.png"],
      // A comma inside a URL token does not end the candidate.
      ["b,c.png", "b,c.png"],
      ["d(e).png", "d(e).png"],
    ]);
  });
});
