import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CapturedWebResource } from "./webMirror.js";
import { planWebMirror } from "./webMirrorPlan.js";

let transaction = 0;
const resource = (
  url: string,
  mediaType: string | null,
  // null records an unreadable body, as a redirect hop has.
  body: string | null = url,
  extra: Partial<
    Pick<CapturedWebResource, "redirected_from_transaction_id">
  > & {
    readonly status?: number;
  } = {},
): CapturedWebResource => {
  transaction += 1;
  return {
    source: {
      kind: "scenario-response",
      transaction_id: `request-${transaction}`,
      request_sequence: transaction,
      response_sequence: transaction,
      status: extra.status ?? 200,
    },
    method: "GET",
    url,
    resource_type: "other",
    redirected_from_transaction_id:
      extra.redirected_from_transaction_id ?? null,
    content:
      body === null
        ? {
            state: "unavailable",
            reason: "body-read-failed",
            message: "redirect",
          }
        : {
            state: "captured",
            base64: Buffer.from(body).toString("base64"),
            bytes: Buffer.byteLength(body),
            sha256: createHash("sha256").update(body).digest("hex"),
            media_type: mediaType,
            redacted: false,
            representation: "playwright-response-body-bytes",
          },
  };
};

const paths = (resources: readonly CapturedWebResource[]) => {
  const plan = planWebMirror(resources);
  return plan.resources.map((outcome) =>
    outcome.kind === "file"
      ? plan.files[outcome.file]?.relativePath
      : outcome.kind,
  );
};

describe("planWebMirror", () => {
  it("maps URLs to readable origin paths with browsable extensions", () => {
    expect(
      paths([
        resource("https://site.test/", "text/html; charset=utf-8"),
        resource("https://site.test/about", "text/html"),
        resource("https://site.test/index.php", "text/html"),
        resource("http://site.test:8080/app.css?v=3", "text/css"),
        resource("https://site.test/data", "application/json"),
        resource("https://site.test/img/a.png", "image/png"),
        resource("https://site.test/raw", null),
      ]),
    ).toEqual([
      "files/https_site.test_443/index.html",
      "files/https_site.test_443/about.html",
      "files/https_site.test_443/index.php.html",
      expect.stringMatching(
        /^files\/http_site\.test_8080\/app~q[0-9a-f]{12}\.css$/u,
      ),
      "files/https_site.test_443/data.json",
      "files/https_site.test_443/img/a.png",
      "files/https_site.test_443/raw",
    ]);
  });

  it("writes identical repeated responses once and isolates differing versions", () => {
    const plan = planWebMirror([
      resource("https://site.test/a.css", "text/css", "same"),
      resource("https://site.test/a.css", "text/css", "same"),
      resource("https://site.test/b.css", "text/css", "one"),
      resource("https://site.test/b.css", "text/css", "two"),
    ]);
    expect(
      plan.files.map(({ relativePath, layout }) => [
        relativePath.split("/").slice(0, 2).join("/"),
        layout,
      ]),
    ).toEqual([
      ["files/https_site.test_443", "url-path"],
      ["files/isolated", "isolated"],
      ["files/isolated", "isolated"],
    ]);
  });

  it("isolates unportable and colliding paths with a reason", () => {
    const plan = planWebMirror([
      resource("https://site.test/img/a@2x.png", "image/png"),
      resource("https://site.test/dir", "text/plain"),
      resource("https://site.test/dir.txt/x", "text/plain"),
      resource("https://site.test/folder/", "image/png"),
    ]);
    expect(
      plan.files.map(({ layout, layoutReason }) => [layout, layoutReason]),
    ).toEqual([
      ["isolated", "URL path is not an ordinary portable file path."],
      [
        "isolated",
        "Captured paths collide by exact name or file/directory prefix.",
      ],
      [
        "isolated",
        "Captured paths collide by exact name or file/directory prefix.",
      ],
      ["isolated", "Directory URL names no file for this media type."],
    ]);
    expect(plan.files[0]?.relativePath).toMatch(
      /^files\/isolated\/resource-1-[0-9a-f]{16}\.png$/u,
    );
  });

  it("isolates names longer than common filesystems hold, including the query suffix", () => {
    const long = "c".repeat(130);
    const plan = planWebMirror([
      resource(`https://site.test/assets/${long}.css?v=12345`, "text/css"),
      resource(`https://site.test/${"b".repeat(300)}`, "text/plain"),
      resource(`https://site.test/${long}.css`, "text/css"),
    ]);
    expect(
      plan.files.map(({ layout, relativePath }) => [
        layout,
        relativePath.split("/").every((part) => part.length <= 143),
      ]),
    ).toEqual([
      ["isolated", true],
      ["isolated", true],
      ["url-path", true],
    ]);
  });

  it("records redirect hops without counting them as missing content", () => {
    const hop = resource("https://site.test/old", null, null, { status: 301 });
    const final = resource("https://site.test/new", "text/html", "<p>", {
      redirected_from_transaction_id: hop.source.transaction_id,
    });
    const gone = resource("https://site.test/gone", null, null, {
      status: 404,
    });
    expect(planWebMirror([hop, final, gone]).resources).toEqual([
      { kind: "redirect", toTransactionId: final.source.transaction_id },
      { kind: "file", file: 0 },
      { kind: "unavailable", reason: "body-read-failed", message: "redirect" },
    ]);
  });
});
