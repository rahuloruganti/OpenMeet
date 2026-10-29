import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialStoreName, isMac, primaryModifierPressed } from "./platform";

afterEach(() => vi.unstubAllGlobals());

it("detects macOS from the user agent", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
  });
  expect(isMac()).toBe(true);
  expect(credentialStoreName()).toBe("Keychain");
});

it("treats Windows as the default", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  expect(isMac()).toBe(false);
  expect(credentialStoreName()).toBe("Windows Credential Manager");
});

describe.each([
  {
    platform: "macOS",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    mac: true,
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    mac: false,
  },
])("primary modifier on $platform", ({ userAgent, mac }) => {
  it.each([
    { ctrlKey: false, metaKey: false },
    { ctrlKey: true, metaKey: false },
    { ctrlKey: false, metaKey: true },
    { ctrlKey: true, metaKey: true },
  ])("handles Ctrl=$ctrlKey, Meta=$metaKey", (event) => {
    vi.stubGlobal("navigator", { userAgent });
    expect(primaryModifierPressed(event)).toBe(
      mac ? event.metaKey : event.ctrlKey,
    );
  });
});
