import { afterEach, expect, it, vi } from "vitest";
import { credentialStoreName, isMac } from "./platform";

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
