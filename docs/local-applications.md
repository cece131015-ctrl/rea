# Local applications

`find_local_applications` / `rea find-local-applications` finds applications
installed on this computer by name. `clone_local_application` /
`rea clone-local-application` copies one into an absent directory for analysis.
Both use one shared workflow through CLI and MCP.

```sh
rea find-local-applications "visual studio code"
rea clone-local-application "LibreOffice" /analysis/libreoffice
rea clone-local-application /Applications/Example.app /analysis/example
rea find-local-applications editor --search-root /opt/tools
```

REA never downloads, installs, starts or updates applications. App stores and
third-party package mirrors are out of scope.

## Where REA looks

| Platform | Default locations                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | `/Applications`, `/Applications/Utilities`, `/System/Applications`, `/System/Applications/Utilities`, `~/Applications` (`*.app` bundles)                           |
| Linux    | XDG desktop entries (`$XDG_DATA_HOME/applications`, each `$XDG_DATA_DIRS/applications`, flatpak and snap exports), `/opt` directories, `~/Applications/*.AppImage` |
| Windows  | Directories in `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%\Programs`                                                                               |

`search_roots` (CLI `--search-root`, repeatable) replaces the defaults; each
entry is an absolute directory (the CLI resolves relative ones against its
working directory) that may hold app bundles, desktop entries, AppImages or
program directories.
Every searched location is reported as `scanned`, `missing`, `unreadable` or
`truncated` (more than 10,000 entries), and coverage is `partial` when a location
could not be read completely. Windows registry entries, Start Menu shortcuts and
Store (MSIX/AppX) packages are not read.

## Names and matches

Matching is case-insensitive substring matching over every known name:
`CFBundleDisplayName`, `CFBundleName`, the bundle directory name and
`CFBundleIdentifier` for macOS bundles; `Name`, localized `Name[locale]`, the
desktop file ID, the program file name and `GenericName` for desktop entries;
the directory or file name otherwise. Each match reports the field that matched
and whether it matched exactly. Exact matches sort first, then visible entries
before `Hidden`/`NoDisplay` ones. Several declarations of one install (for
example several desktop entries for one office suite) are reported once.

Info.plist files are decoded by REA's existing in-process decoder (binary or
XML); desktop entries follow the freedesktop Desktop Entry specification,
including escapes, `Exec` quoting and field codes. A desktop entry's program is
`TryExec` or the first `Exec` argument (after an `env` wrapper), found on `PATH`
and resolved through symbolic links. Its installed files are the package
directory below a known install location (for example `/usr/lib/libreoffice`
for `/usr/lib/libreoffice/program/soffice`), the flatpak or snap install, or the
program's own directory. A program that lives directly in a shared command
directory such as `/usr/bin` is selected as a single file, with a limitation:
libraries and data it loads from elsewhere are not included. Electron
`app.asar` archives at the usual bundle locations are reported.

## Copies

`application` is an absolute path (bundle, directory, desktop entry or file) or
a name. The CLI treats an argument with a path separator, `.` or `..` as a path
and anything else, including dot-prefixed names such as `.NET`, as a name. A name must select exactly one application: a single exact match, or a
single match. Otherwise the call fails without writing and lists up to 20
candidates; pass one candidate's path instead.

Directories are copied by the artifact extraction owner: regular files only,
symbolic links are neither followed nor recreated (their count is stated),
every write is verified by SHA-256 and re-read, and failure or cancellation
rolls the owned output back. A single file is digested, copied and re-verified
the same way; cancellation is reported as cancelled, and a cleanup that cannot
complete stays owned by the session and is reported with its residual path.
The result reports the file count, bytes, a digest over the copied file set and
analysis inputs, for example each copied `app.asar` for
`analyze_javascript_application`. Settings, caches and data stored outside the
installed files are not included.
