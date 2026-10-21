import type {
  CapturedWebScript,
  ExportedWebScript,
} from "./webScriptExport.js";
import { urlDeclaresQueryOrFragment } from "./urlComponents.js";
import {
  conflictingPaths,
  isPortablePathSegment,
  sha256Text,
} from "./webExportPaths.js";

/** One planned file, or an explicit missing source with no filesystem effect. */
export interface PlannedWebScript {
  readonly script: CapturedWebScript;
  readonly record: ExportedWebScript;
}

/** Preserve safe URL layouts only when every captured path is unambiguous. */
export const planWebScriptExport = (
  scripts: readonly CapturedWebScript[],
): readonly PlannedWebScript[] => {
  const candidates = scripts.map(candidatePath);
  const conflicts = conflictingPaths(candidates.map(({ path }) => path));
  return scripts.map((script, index) => {
    if (script.content.state === "unavailable")
      return {
        script,
        record: {
          source: script.source,
          url: script.url,
          content: script.content,
        },
      };
    const candidate = candidates[index];
    const reason = conflicts.has(index)
      ? "Captured paths collide by content version or file/directory prefix."
      : (candidate?.reason ?? null);
    const path = reason === null ? candidate?.path : undefined;
    return {
      script,
      record: {
        source: script.source,
        url: script.url,
        content: {
          state: "exported",
          relative_path: path ?? isolatedScriptPath(script, index),
          layout: path === undefined ? "isolated" : "url-path",
          layout_reason: reason,
          sha256: script.content.sha256,
          bytes: script.content.bytes.length,
          media_type: script.content.media_type,
          redacted: script.content.redacted,
          representation: script.content.representation,
        },
      },
    };
  });
};

/** The collision-free name for a source whose URL path cannot be kept. */
export const isolatedScriptPath = (
  script: CapturedWebScript,
  index: number,
): string =>
  `isolated/source-${index + 1}-${sha256Text(JSON.stringify(script.source))}.js`;

interface CandidatePath {
  readonly path?: string;
  readonly reason: string | null;
}

const candidatePath = (script: CapturedWebScript): CandidatePath => {
  let url: URL;
  try {
    url = new URL(script.url);
  } catch {
    return {
      reason: "Source has no absolute HTTP URL (for example an inline script).",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { reason: "Source URL scheme has no local module layout mapping." };
  const parts = url.pathname.slice(1).split("/");
  if (
    !/\.(?:js|mjs|cjs)$/u.test(url.pathname) ||
    !parts.every(isPortablePathSegment)
  )
    return {
      reason: "URL path is not an ordinary portable JavaScript module path.",
    };
  return {
    path: `origins/${sha256Text(url.origin)}/${parts.join("/")}`,
    reason:
      urlDeclaresQueryOrFragment(url) ||
      url.username !== "" ||
      url.password !== ""
        ? "URL query, fragment, or credentials cannot select a canonical local module."
        : null,
  };
};
