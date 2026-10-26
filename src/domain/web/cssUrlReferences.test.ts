import { describe, expect, it } from "vitest";

import { cssString, cssUrlReferences } from "./cssUrlReferences.js";

const urls = (text: string) =>
  cssUrlReferences(text).map(({ kind, url, range }) => ({
    kind,
    url,
    source: text.slice(range.start, range.end),
  }));

describe("cssUrlReferences", () => {
  it("finds unquoted and quoted url() references and @import forms", () => {
    expect(
      urls(
        `@import "a.css"; @import url(b.css) screen; .x { background: url( 'c.png' ) } .y{src:url(d.woff2)}`,
      ),
    ).toEqual([
      { kind: "string", url: "a.css", source: '"a.css"' },
      { kind: "url-token", url: "b.css", source: "url(b.css)" },
      { kind: "string", url: "c.png", source: "'c.png'" },
      { kind: "url-token", url: "d.woff2", source: "url(d.woff2)" },
    ]);
  });

  it("ignores URLs inside comments, strings and hash tokens", () => {
    expect(
      urls(
        `/* url(no.png) */ .a::after { content: "url(no.png)" } #url(x) .b{background:URL(yes.png)}`,
      ),
    ).toEqual([{ kind: "url-token", url: "yes.png", source: "URL(yes.png)" }]);
  });

  it("decodes escapes in names, strings and URL tokens", () => {
    expect(
      urls(`.a{background:\\75 rl(e\\28 x.png)} .b{b:url("q\\"r.png")}`),
    ).toEqual([
      { kind: "url-token", url: "e(x.png", source: "\\75 rl(e\\28 x.png)" },
      { kind: "string", url: 'q"r.png', source: '"q\\"r.png"' },
    ]);
  });

  it("skips bad URLs and bad strings", () => {
    expect(urls(`.a{b:url(bad url.png)} .c{d:url(ok.png)}`)).toEqual([
      { kind: "url-token", url: "ok.png", source: "url(ok.png)" },
    ]);
    expect(urls(`@import "unterminated\n.c{d:url(ok.png)}`)).toEqual([
      { kind: "url-token", url: "ok.png", source: "url(ok.png)" },
    ]);
  });

  it("treats direct string arguments of image-set functions as URLs", () => {
    expect(
      urls(
        `.a{b:image-set("a.png" 1x,'b.png' 2x)} .c{d:-webkit-image-set(url(c.png) 1x, "d.avif" type("image/avif"))} .e{f:g("no.png")}`,
      ),
    ).toEqual([
      { kind: "string", url: "a.png", source: '"a.png"' },
      { kind: "string", url: "b.png", source: "'b.png'" },
      { kind: "url-token", url: "c.png", source: "url(c.png)" },
      { kind: "string", url: "d.avif", source: '"d.avif"' },
    ]);
  });

  it("writes CSS strings that round-trip through the tokenizer", () => {
    const written = cssString('a"b\\c\nd');
    expect(cssUrlReferences(`@import ${written};`)[0]?.url).toBe('a"b\\c\nd');
  });
});
