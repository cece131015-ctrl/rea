import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { defaultSearchRoots } from "../../../src/application/localApplications/LocalApplicationDiscovery.js";
import {
  cloneLocalApplication,
  findLocalApplications,
} from "../../../src/application/localApplications/LocalApplicationService.js";
import type { LocalApplicationHost } from "../../../src/application/localApplications/LocalApplicationDiscovery.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  localApplicationCloneSchema,
  localApplicationDiscoverySchema,
} from "../../../src/domain/localApplications.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const it_ = it.skipIf(process.platform === "win32");

const infoPlist = (fields: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(
    fields,
  )
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("")}</dict></plist>\n`;

const executable = async (path: string, text = "#!/bin/sh\n") => {
  await writeFile(path, text);
  await chmod(path, 0o755);
};

const find = async (
  host: LocalApplicationHost,
  query: string,
  roots?: string[],
) => {
  const result = await findLocalApplications(
    { query, ...(roots === undefined ? {} : { search_roots: roots }) },
    host,
  );
  if (!result.ok) throw result.error;
  return localApplicationDiscoverySchema.parse(result.value.normalized_result);
};

describe("find_local_applications", () => {
  it_(
    "reads macOS bundle metadata and Electron archives from bundle roots",
    async () => {
      const root = await createTestTempDirectory("rea-local-apps-macos-");
      const bundle = join(root, "Editor.app");
      await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
      await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
      await writeFile(
        join(bundle, "Contents", "Info.plist"),
        infoPlist({
          CFBundleName: "Editor",
          CFBundleDisplayName: "Code Editor",
          CFBundleIdentifier: "com.example.editor",
          CFBundleShortVersionString: "1.2.3",
          CFBundleExecutable: "Editor",
        }),
      );
      await executable(join(bundle, "Contents", "MacOS", "Editor"));
      await writeFile(
        join(bundle, "Contents", "Resources", "app.asar"),
        "asar",
      );
      const discovery = await find(
        { platform: "darwin", environment: {}, homeDirectory: root },
        "com.example.EDITOR",
        [root],
      );
      expect(discovery.matches).toEqual([
        expect.objectContaining({
          name: "Editor",
          display_name: "Code Editor",
          bundle_identifier: "com.example.editor",
          version: "1.2.3",
          kind: "macos-app-bundle",
          root_kind: "directory",
          matched_field: "CFBundleIdentifier",
          exact: true,
          electron_asar_paths: [
            join(bundle, "Contents", "Resources", "app.asar"),
          ],
        }),
      ]);
      expect(discovery.matches[0]?.executable_path).toMatch(
        /MacOS[/\\]Editor$/u,
      );
    },
  );
});

describe("find_local_applications on Linux and Windows hosts", () => {
  it_(
    "resolves Linux desktop entries to package roots or single shared files",
    async () => {
      const root = await createTestTempDirectory("rea-local-apps-linux-");
      const home = join(root, "home");
      const share = join(root, "share");
      const applications = join(share, "applications");
      const bin = join(root, "bin");
      await mkdir(applications, { recursive: true });
      await mkdir(join(home, ".local", "bin"), { recursive: true });
      await mkdir(join(home, ".local", "share", "writer", "program"), {
        recursive: true,
      });
      await mkdir(bin, { recursive: true });
      const writer = join(
        home,
        ".local",
        "share",
        "writer",
        "program",
        "soffice",
      );
      await executable(writer);
      await symlink(writer, join(bin, "writer"));
      await executable(join(home, ".local", "bin", "tool"));
      await writeFile(
        join(applications, "writer.desktop"),
        "[Desktop Entry]\nType=Application\nName=Office Writer\nName[es]=Procesador\nExec=writer %U\n",
      );
      await writeFile(
        join(applications, "writer-hidden.desktop"),
        "[Desktop Entry]\nType=Application\nName=Office Writer Filters\nNoDisplay=true\nExec=writer\n",
      );
      await writeFile(
        join(applications, "tool.desktop"),
        `[Desktop Entry]\nType=Application\nName=Tool\nExec=env FOO=1 "${join(home, ".local", "bin", "tool")}"\n`,
      );
      await writeFile(
        join(applications, "link.desktop"),
        "[Desktop Entry]\nType=Link\nName=Office Website\n",
      );
      const host: LocalApplicationHost = {
        platform: "linux",
        environment: {
          PATH: bin,
          XDG_DATA_HOME: join(root, "none"),
          XDG_DATA_DIRS: share,
        },
        homeDirectory: home,
      };
      expect(defaultSearchRoots(host).map(({ path }) => path)).toContain(
        applications,
      );

      const office = await find(host, "office");
      expect(office.matches).toEqual([
        expect.objectContaining({
          name: "Office Writer",
          kind: "desktop-entry",
          root_path: join(home, ".local", "share", "writer"),
          root_kind: "directory",
          executable_path: writer,
          exact: false,
          limitations: [],
        }),
      ]);
      expect((await find(host, "procesador")).matches[0]?.matched_field).toBe(
        "Name[locale]",
      );
      expect((await find(host, "tool")).matches[0]).toMatchObject({
        root_path: join(home, ".local", "bin", "tool"),
        root_kind: "file",
        exact: true,
      });
      expect(
        office.roots.find(({ path }) => path === applications),
      ).toMatchObject({
        state: "scanned",
        strategy: "desktop-entries",
      });
      expect(office.coverage.status).toBe("complete");
    },
  );

  it_(
    "lists Windows program directories and reports missing roots",
    async () => {
      const root = await createTestTempDirectory("rea-local-apps-windows-");
      await mkdir(join(root, "Programs", "Example Studio", "resources"), {
        recursive: true,
      });
      await writeFile(
        join(root, "Programs", "Example Studio", "resources", "app.asar"),
        "a",
      );
      const discovery = await find(
        {
          platform: "win32",
          environment: {
            ProgramFiles: join(root, "Absent"),
            LOCALAPPDATA: root,
          },
          homeDirectory: root,
        },
        "studio",
      );
      expect(discovery.matches).toEqual([
        expect.objectContaining({
          name: "Example Studio",
          kind: "program-directory",
        }),
      ]);
      expect(discovery.roots.map(({ state }) => state)).toEqual([
        "missing",
        "scanned",
      ]);
      expect(discovery.limitations.join(" ")).toContain("registry");
    },
  );
});

const cloneSetup = async () => {
  const root = await createTestTempDirectory("rea-local-apps-clone-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const host: LocalApplicationHost = {
    platform: "linux",
    environment: {},
    homeDirectory: root,
  };
  const apps = join(root, "apps");
  await mkdir(join(apps, "Viewer", "resources"), { recursive: true });
  await mkdir(join(apps, "Viewer Pro"), { recursive: true });
  await writeFile(join(apps, "Viewer", "viewer"), "binary");
  await writeFile(join(apps, "Viewer", "resources", "app.asar"), "archive");
  await symlink(join(root, "outside"), join(apps, "Viewer", "link"));
  return { root, apps, host, resources };
};

describe("clone_local_application", () => {
  it_(
    "copies a uniquely selected directory with digests and analysis inputs",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      const output = join(root, "copy");
      const result = await cloneLocalApplication(
        {
          application: "viewer",
          output_directory: output,
          search_roots: [apps],
        },
        { host, resources },
      );
      if (!result.ok) throw result.error;
      const clone = localApplicationCloneSchema.parse(
        result.value.normalized_result,
      );
      expect(clone.selection).toEqual({
        kind: "query",
        query: "viewer",
        matches_considered: 2,
      });
      expect(clone.copy).toMatchObject({
        root_kind: "directory",
        files: 2,
        bytes: 13,
      });
      expect(clone.analysis_inputs).toEqual([
        {
          operation: "analyze_javascript_application",
          input_path: join(output, "resources", "app.asar"),
        },
      ]);
      expect(clone.limitations.join(" ")).toContain(
        "1 symbolic link was not recreated",
      );
      expect(await readFile(join(output, "viewer"), "utf8")).toBe("binary");
      expect((await readdir(output)).sort()).toEqual(["resources", "viewer"]);
    },
  );

  it_(
    "lists candidates for an ambiguous name and copies a selected file by path",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      const ambiguous = await cloneLocalApplication(
        {
          application: "view",
          output_directory: join(root, "x"),
          search_roots: [apps],
        },
        { host, resources },
      );
      if (ambiguous.ok) throw new Error("Expected an ambiguous selection");
      expect(JSON.stringify(projectAnalysisError(ambiguous.error))).toContain(
        "matches 2 applications",
      );
      expect(await readdir(root)).not.toContain("x");

      const file = join(apps, "Viewer", "viewer");
      const copied = await cloneLocalApplication(
        { application: file, output_directory: join(root, "single") },
        { host, resources },
      );
      if (!copied.ok) throw copied.error;
      const clone = localApplicationCloneSchema.parse(
        copied.value.normalized_result,
      );
      expect(clone.copy).toEqual({
        root_kind: "file",
        files: 1,
        bytes: 6,
        files_sha256: createHash("sha256").update("binary").digest("hex"),
        extraction_id: null,
      });
      expect(await readFile(join(root, "single", "viewer"), "utf8")).toBe(
        "binary",
      );
    },
  );

  it_(
    "refuses an existing destination and a missing name without writing",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      await writeFile(join(root, "taken"), "keep");
      const existing = await cloneLocalApplication(
        {
          application: join(apps, "Viewer"),
          output_directory: join(root, "taken"),
        },
        { host, resources },
      );
      if (existing.ok) throw new Error("Expected exclusive output failure");
      expect(await readFile(join(root, "taken"), "utf8")).toBe("keep");

      const missing = await cloneLocalApplication(
        {
          application: "nothing-here",
          output_directory: join(root, "y"),
          search_roots: [apps],
        },
        { host, resources },
      );
      if (missing.ok) throw new Error("Expected no match");
      expect(JSON.stringify(projectAnalysisError(missing.error))).toContain(
        "No installed application matches",
      );
    },
  );
});

describe("clone_local_application safety", () => {
  it_(
    "never selects a filesystem root, the home directory or its own output",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      for (const [application, output, message] of [
        ["/", join(root, "a"), "filesystem root"],
        [root, join(root, "b"), "home directory"],
        [
          join(apps, "Viewer"),
          join(apps, "Viewer", "copy"),
          "inside the application",
        ],
      ] as const) {
        const result = await cloneLocalApplication(
          { application, output_directory: output },
          { host, resources },
        );
        if (result.ok) throw new Error(`Expected ${application} to be refused`);
        expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
          message,
        );
      }
      expect((await readdir(root)).sort()).toEqual(["apps"]);
    },
  );

  it_(
    "selects only the program file when it is not in a package directory",
    async () => {
      const { root, host } = await cloneSetup();
      const loose = join(root, "loose");
      await mkdir(join(loose, "unrelated"), { recursive: true });
      await executable(join(loose, "tool"));
      await writeFile(
        join(loose, "tool.desktop"),
        `[Desktop Entry]\nType=Application\nName=Loose Tool\nExec=${join(loose, "tool")}\n`,
      );
      const discovery = await find(host, "loose tool", [loose]);
      expect(discovery.matches[0]).toMatchObject({
        root_path: join(loose, "tool"),
        root_kind: "file",
        limitations: [expect.stringContaining("only its executable file")],
      });
    },
  );

  it_(
    "reports a cancelled directory or single-file copy as cancelled",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      const controller = new AbortController();
      controller.abort();
      for (const [application, output] of [
        [join(apps, "Viewer"), "z"],
        [join(apps, "Viewer", "viewer"), "z1"],
      ] as const) {
        const result = await cloneLocalApplication(
          { application, output_directory: join(root, output) },
          { host, resources },
          { signal: controller.signal },
        );
        if (result.ok)
          throw new Error(`Expected ${application} to be cancelled`);
        expect(projectAnalysisError(result.error).code).toBe("cancelled");
      }
      expect((await readdir(root)).sort()).toEqual(["apps"]);
    },
  );

  it_("rejects relative search roots as discovery does", async () => {
    const { root, host, resources } = await cloneSetup();
    const result = await cloneLocalApplication(
      {
        application: "viewer",
        output_directory: join(root, "r"),
        search_roots: ["apps"],
      },
      { host, resources },
    );
    if (result.ok) throw new Error("Expected a relative root to be refused");
    expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
      "search_roots must be absolute filesystem paths; received apps.",
    );
    expect((await readdir(root)).sort()).toEqual(["apps"]);
  });
});

describe("find_local_applications desktop entry installs", () => {
  const desktopHost = async () => {
    const root = await createTestTempDirectory("rea-local-apps-installs-");
    const home = join(root, "home");
    const share = join(home, ".local", "share");
    const applications = join(share, "applications");
    await mkdir(applications, { recursive: true });
    const host: LocalApplicationHost = {
      platform: "linux",
      environment: { PATH: join(root, "none"), XDG_DATA_DIRS: join(root, "x") },
      homeDirectory: home,
    };
    const entry = (name: string, exec: string) =>
      writeFile(
        join(applications, `${name}.desktop`),
        `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\n`,
      );
    return { root, share, applications, host, entry };
  };

  it_(
    "selects one product below a vendor directory, never the vendor directory",
    async () => {
      const { share, host, entry } = await desktopHost();
      for (const product of ["browser", "browser-beta"]) {
        await mkdir(join(share, "Vendor", product), { recursive: true });
        await executable(join(share, "Vendor", product, "run"));
        await entry(`Vendor ${product}`, join(share, "Vendor", product, "run"));
      }
      await mkdir(join(share, "Tool", "bin"), { recursive: true });
      await executable(join(share, "Tool", "bin", "tool"));
      await entry("Toolbox", join(share, "Tool", "bin", "tool"));
      expect(
        (await find(host, "vendor")).matches.map(({ root_path }) => root_path),
      ).toEqual([
        join(share, "Vendor", "browser"),
        join(share, "Vendor", "browser-beta"),
      ]);
      expect((await find(host, "toolbox")).matches[0]?.root_path).toBe(
        join(share, "Tool"),
      );
    },
  );

  it_(
    "selects an interpreted application's file, not its interpreter",
    async () => {
      const { share, host, entry } = await desktopHost();
      await mkdir(join(share, "pytool"), { recursive: true });
      await writeFile(join(share, "pytool", "main.py"), "print(1)\n");
      await entry("PyTool", `python3 -u ${join(share, "pytool", "main.py")}`);
      await entry("Inline", 'sh -c "echo hi"');
      expect((await find(host, "pytool")).matches[0]).toMatchObject({
        root_path: join(share, "pytool"),
        root_kind: "directory",
        limitations: [expect.stringContaining("runs python3 on")],
      });
      expect((await find(host, "inline")).matches[0]).toMatchObject({
        root_path: null,
        limitations: [expect.stringContaining("inline sh command")],
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps scanning a root past an unreadable subdirectory",
    async () => {
      const { applications, host, entry, share } = await desktopHost();
      await mkdir(join(applications, "aa-locked"));
      await chmod(join(applications, "aa-locked"), 0o000);
      onTestFinished(() => chmod(join(applications, "aa-locked"), 0o755));
      await mkdir(join(share, "late"), { recursive: true });
      await executable(join(share, "late", "late"));
      await entry("Late", join(share, "late", "late"));
      const discovery = await find(host, "late");
      expect(discovery.matches).toHaveLength(1);
      expect(
        discovery.roots.find(({ path }) => path === applications),
      ).toMatchObject({ state: "partial" });
      expect(discovery.coverage.status).toBe("partial");
    },
  );
});

describe("clone_local_application name selection", () => {
  it_(
    "states unverified uniqueness when a searched location was not read",
    async () => {
      const { root, apps, host, resources } = await cloneSetup();
      await writeFile(join(root, "not-a-directory"), "x");
      const result = await cloneLocalApplication(
        {
          application: "viewer",
          output_directory: join(root, "copy"),
          search_roots: [apps, join(root, "not-a-directory")],
        },
        { host, resources },
      );
      if (!result.ok) throw result.error;
      expect(
        localApplicationCloneSchema.parse(result.value.normalized_result)
          .limitations,
      ).toContainEqual(
        expect.stringContaining("only among the locations read"),
      );
    },
  );

  it_("counts only exact candidates when several match exactly", async () => {
    const { root, apps, host, resources } = await cloneSetup();
    const second = join(root, "more");
    await mkdir(join(second, "Viewer"), { recursive: true });
    await writeFile(join(second, "Viewer", "viewer"), "other");
    const result = await cloneLocalApplication(
      {
        application: "viewer",
        output_directory: join(root, "copy"),
        search_roots: [apps, second],
      },
      { host, resources },
    );
    if (result.ok) throw new Error("Expected an ambiguous exact name");
    const message = JSON.stringify(projectAnalysisError(result.error));
    expect(message).toContain("matches 2 applications exactly");
    expect(message).not.toContain("; and ");
  });
});
