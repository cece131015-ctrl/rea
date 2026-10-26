import { describe, expect, it } from "vitest";

import { rewriteCss, rewriteHtml } from "./webMirrorRewrite.js";

const captured = new Map([
  ["https://site.test/", "view/https_site.test_443/index.html"],
  ["https://site.test/app.css?v=2", "view/https_site.test_443/app~q1.css"],
  ["https://site.test/img/logo.png", "files/https_site.test_443/img/logo.png"],
  ["https://site.test/a.js", "files/https_site.test_443/a.js"],
]);
const lookup = (url: string) => captured.get(url);
const fromPath = "view/https_site.test_443/index.html";
const documentUrl = new URL("https://site.test/");

describe("rewriteHtml", () => {
  it("links captured references locally and keeps everything else byte-identical", () => {
    const html = `<!-- keep --><link rel="stylesheet" href="app.css?v=2" integrity="sha256-x" crossorigin>\n<img src=/img/logo.png#top alt="Ä"><a href="#here">h</a><a href="about">a</a><a href="mailto:x@y">m</a>`;
    const rewritten = rewriteHtml(html, documentUrl, { fromPath, lookup });
    expect(rewritten.text).toBe(
      `<!-- keep --><link rel="stylesheet" href="app~q1.css"  >\n<img src="../../files/https_site.test_443/img/logo.png#top" alt="Ä"><a href="#here">h</a><a href="https://site.test/about">a</a><a href="mailto:x@y">m</a>`,
    );
    expect(rewritten).toMatchObject({
      rewritten: 2,
      unresolved: 1,
      removedAttributes: 2,
    });
  });

  it("resolves against base href and points the base at the view file itself", () => {
    const html = `<base href="https://site.test/img/"><img src="logo.png"><a href="#faq">f</a><a href="">e</a>`;
    expect(
      rewriteHtml(html, new URL("https://site.test/deep/page"), {
        fromPath,
        lookup,
      }).text,
    ).toBe(
      `<base href="index.html"><img src="../../files/https_site.test_443/img/logo.png"><a href="https://site.test/img/#faq">f</a><a href="https://site.test/img/">e</a>`,
    );
  });

  it("keeps in-page fragments when the base is the document itself", () => {
    const html = `<base href="/"><a href="#faq">f</a><a href="">e</a><a href="app.css?v=2#x">c</a>`;
    expect(rewriteHtml(html, documentUrl, { fromPath, lookup }).text).toBe(
      `<base href="index.html"><a href="#faq">f</a><a href="">e</a><a href="app~q1.css#x">c</a>`,
    );
  });

  it("takes the first non-template base with an href, even an empty one", () => {
    const html = `<template><base href="https://other.test/"></template><base href=""><base href="https://other.test/"><img src="/img/logo.png">`;
    expect(rewriteHtml(html, documentUrl, { fromPath, lookup }).text).toBe(
      `<template><base href="https://other.test/"></template><base href="index.html"><base href="https://other.test/"><img src="../../files/https_site.test_443/img/logo.png">`,
    );
  });

  it("rewrites a reference once when parse5 reconstructs an open formatting element", () => {
    const html = `<p><a href="/img/logo.png">L<p>More</a>`;
    expect(rewriteHtml(html, documentUrl, { fromPath, lookup })).toMatchObject({
      text: `<p><a href="../../files/https_site.test_443/img/logo.png">L<p>More</a>`,
      rewritten: 1,
    });
  });

  it("rewrites srcset candidates, style attributes and style elements", () => {
    const html = `<img srcset="/img/logo.png 1x, /img/big.png 2x"><p style="background:url(&quot;/img/logo.png&quot;)"></p><style>p{background:url(/img/logo.png)}</style>`;
    const rewritten = rewriteHtml(html, documentUrl, { fromPath, lookup });
    expect(rewritten.text).toBe(
      `<img srcset="../../files/https_site.test_443/img/logo.png 1x, https://site.test/img/big.png 2x"><p style="background:url(&quot;../../files/https_site.test_443/img/logo.png&quot;)"></p><style>p{background:url("../../files/https_site.test_443/img/logo.png")}</style>`,
    );
    expect(rewritten.rewritten).toBe(3);
    expect(rewritten.unresolved).toBe(1);
  });
});

describe("rewriteCss", () => {
  it("rewrites url() and @import relative to the view file", () => {
    const css = `@import "app.css?v=2"; /* url(no.png) */ b{background:url(img/logo.png)}`;
    expect(
      rewriteCss(css, new URL("https://site.test/x.css"), {
        fromPath: "view/https_site.test_443/x.css",
        lookup,
      }).text,
    ).toBe(
      `@import "app~q1.css"; /* url(no.png) */ b{background:url("../../files/https_site.test_443/img/logo.png")}`,
    );
  });
});
