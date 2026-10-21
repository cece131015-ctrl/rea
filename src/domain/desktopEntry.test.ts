import { describe, expect, it } from "vitest";

import { parseDesktopEntry, parseDesktopExec } from "./desktopEntry.js";

describe("parseDesktopEntry", () => {
  it("reads the Desktop Entry group with escapes, localized names and flags", () => {
    const entry = parseDesktopEntry(
      [
        "# comment",
        "[Desktop Entry]",
        "Type=Application",
        "Name=Code\\sEditor",
        "Name[es]=Editor de código",
        "Name=Ignored duplicate",
        "GenericName=Text Editor",
        "Exec=/opt/code/code --new-window %F",
        "NoDisplay=true",
        "X-Flatpak=com.example.Code",
        "[Desktop Action new]",
        "Name=Other group",
      ].join("\n"),
    );
    expect(entry).toMatchObject({
      type: "Application",
      name: "Code Editor",
      localizedNames: ["Editor de código"],
      genericName: "Text Editor",
      exec: ["/opt/code/code", "--new-window"],
      hidden: false,
      noDisplay: true,
    });
    expect(entry?.keys.get("X-Flatpak")).toBe("com.example.Code");
  });

  it("returns null without a Desktop Entry group", () => {
    expect(parseDesktopEntry("[Other]\nName=x\n")).toBeNull();
  });
});

describe("parseDesktopExec", () => {
  it("applies quoting rules and removes field codes", () => {
    expect(
      parseDesktopExec(
        '"/opt/My App/run" --flag="a b" %U "quoted \\"x\\"" 100%%',
      ),
    ).toEqual(["/opt/My App/run", "--flag=a b", 'quoted "x"', "100%"]);
  });

  it("rejects unterminated quotes", () => {
    expect(parseDesktopExec('"/opt/app')).toBeNull();
  });
});
