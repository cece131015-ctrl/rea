import { mediaTypeEssence } from "./analysisView/recordedMediaType.js";
import {
  conflictingPaths,
  isPortablePathSegment,
  sha256Text,
} from "./webExportPaths.js";
import type {
  CapturedWebResource,
  CapturedWebResourceBody,
} from "./webMirror.js";

// Browsers loading file:// URLs infer types from extensions, so a mirror
// keeps one of these per well-known type; the first is canonical.
const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "text/html": [".html", ".htm"],
  "application/xhtml+xml": [".xhtml", ".xht"],
  "text/css": [".css"],
  "text/javascript": [".js", ".mjs", ".cjs"],
  "application/javascript": [".js", ".mjs", ".cjs"],
  "application/x-javascript": [".js", ".mjs", ".cjs"],
  "application/json": [".json"],
  "application/manifest+json": [".webmanifest", ".json"],
  "application/wasm": [".wasm"],
  "application/xml": [".xml"],
  "text/xml": [".xml"],
  "text/plain": [".txt"],
  "image/svg+xml": [".svg"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/avif": [".avif"],
  "image/x-icon": [".ico"],
  "image/vnd.microsoft.icon": [".ico"],
  "font/woff": [".woff"],
  "font/woff2": [".woff2"],
  "font/ttf": [".ttf"],
  "font/otf": [".otf"],
  "application/font-woff": [".woff"],
  "video/mp4": [".mp4"],
  "video/webm": [".webm"],
  "audio/mpeg": [".mp3"],
};

/** Exact-file planning for one unique (URL, bytes) pair. */
export interface PlannedMirrorFile {
  /** Output-root relative path under `files/`. */
  readonly relativePath: string;
  /** The collision-free path used if the destination rejects the URL path. */
  readonly isolatedPath: string;
  readonly layout: "url-path" | "isolated";
  readonly layoutReason: string | null;
  readonly url: string;
  readonly essence: string | null;
  readonly body: CapturedWebResourceBody;
}

/** The planned outcome of one captured transaction. */
export type PlannedMirrorResource =
  | { readonly kind: "file"; readonly file: number }
  | { readonly kind: "redirect"; readonly toTransactionId: string }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly message: string;
    };

export interface WebMirrorPlan {
  readonly files: readonly PlannedMirrorFile[];
  /** One outcome per captured resource, in capture order. */
  readonly resources: readonly PlannedMirrorResource[];
}

/** The URL identity a reference resolves to; fragments never select bytes. */
export const mirrorUrlKey = (value: string): string | null => {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

const essenceOf = (body: CapturedWebResourceBody): string | null =>
  body.media_type === null ? null : mediaTypeEssence(body.media_type);

/**
 * Plan one exact file per unique captured (URL, bytes) pair. Ordinary URL
 * paths keep their layout under a readable origin directory; collisions,
 * versions of one URL and unrepresentable paths are isolated with a reason.
 */
export const planWebMirror = (
  resources: readonly CapturedWebResource[],
): WebMirrorPlan => {
  const unique = new Map<string, number>();
  const versions = new Map<string, Set<string>>();
  const files: Omit<
    PlannedMirrorFile,
    "relativePath" | "isolatedPath" | "layout" | "layoutReason"
  >[] = [];
  const outcomes: (PlannedMirrorResource | undefined)[] = resources.map(
    (resource) => {
      const content = resource.content;
      if (content.state !== "captured") return undefined;
      const key = mirrorUrlKey(resource.url) ?? resource.url;
      const identity = `${key}\n${content.sha256}`;
      let file = unique.get(identity);
      if (file === undefined) {
        file = files.length;
        unique.set(identity, file);
        files.push({
          url: resource.url,
          essence: essenceOf(content),
          body: content,
        });
      }
      versions.set(key, (versions.get(key) ?? new Set()).add(content.sha256));
      return { kind: "file", file };
    },
  );
  const redirectedFrom = new Map<string, string>();
  for (const resource of resources)
    if (resource.redirected_from_transaction_id !== null)
      redirectedFrom.set(
        resource.redirected_from_transaction_id,
        resource.source.transaction_id,
      );
  const candidates = files.map((file) =>
    (versions.get(mirrorUrlKey(file.url) ?? file.url)?.size ?? 0) > 1
      ? {
          reason:
            "The same URL was captured with different bytes; each version is isolated.",
          extension: canonicalExtension(file.url, file.essence),
        }
      : candidatePath(file.url, file.essence),
  );
  const conflicts = conflictingPaths(candidates.map(({ path }) => path));
  const planned = files.map((file, index): PlannedMirrorFile => {
    const candidate = candidates[index];
    const reason = conflicts.has(index)
      ? "Captured paths collide by exact name or file/directory prefix."
      : (candidate?.reason ?? null);
    const isolatedPath = `files/isolated/resource-${index + 1}-${file.body.sha256.slice(0, 16)}${candidate?.extension ?? ""}`;
    return reason === null && candidate?.path !== undefined
      ? {
          ...file,
          relativePath: `files/${candidate.path}`,
          isolatedPath,
          layout: "url-path",
          layoutReason: null,
        }
      : {
          ...file,
          relativePath: isolatedPath,
          isolatedPath,
          layout: "isolated",
          layoutReason: reason,
        };
  });
  return {
    files: planned,
    resources: resources.map((resource, index): PlannedMirrorResource => {
      const outcome = outcomes[index];
      if (outcome !== undefined) return outcome;
      const content = resource.content;
      const status = resource.source.status;
      const next = redirectedFrom.get(resource.source.transaction_id);
      if (
        status !== null &&
        status >= 300 &&
        status < 400 &&
        next !== undefined
      )
        return { kind: "redirect", toTransactionId: next };
      return content.state === "unavailable"
        ? {
            kind: "unavailable",
            reason: content.reason,
            message: content.message,
          }
        : {
            kind: "unavailable",
            reason: "unavailable",
            message: "No bytes were retained.",
          };
    }),
  };
};

interface CandidatePath {
  readonly path?: string;
  readonly reason: string | null;
  readonly extension: string;
}

const canonicalExtension = (value: string, essence: string | null): string => {
  const expected = essence === null ? undefined : TYPE_EXTENSIONS[essence];
  if (expected !== undefined) return expected[0] ?? "";
  try {
    const name = new URL(value).pathname.split("/").at(-1) ?? "";
    const extension = extensionOf(name);
    return isPortablePathSegment(`x${extension}`) ? extension : "";
  } catch {
    return "";
  }
};

/** Readable portable origin directory, or a digest when the host is not portable. */
const originDirectory = (url: URL): string => {
  const port =
    url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  const readable = `${url.protocol.slice(0, -1)}_${url.hostname}_${port}`;
  return isPortablePathSegment(readable)
    ? readable
    : `origin-${sha256Text(url.origin).slice(0, 16)}`;
};

const candidatePath = (
  value: string,
  essence: string | null,
): CandidatePath => {
  const extension = canonicalExtension(value, essence);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "Resource has no absolute URL.", extension };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { reason: "URL scheme has no local mirror mapping.", extension };
  const segments = url.pathname.slice(1).split("/");
  let name = segments.pop() ?? "";
  if (name === "") {
    if (essence !== "text/html")
      return {
        reason: "Directory URL names no file for this media type.",
        extension,
      };
    name = "index.html";
  }
  const expected = essence === null ? undefined : TYPE_EXTENSIONS[essence];
  if (expected !== undefined && !expected.includes(extensionOf(name)))
    name = `${name}${expected[0] ?? ""}`;
  if (url.href.includes("?")) {
    const kept = extensionOf(name);
    name = `${name.slice(0, name.length - kept.length)}~q${sha256Text(url.search).slice(0, 12)}${kept}`;
  }
  const parts = [originDirectory(url), ...segments, name];
  return parts.every(isPortablePathSegment)
    ? { path: parts.join("/"), reason: null, extension }
    : {
        reason: "URL path is not an ordinary portable file path.",
        extension,
      };
};
