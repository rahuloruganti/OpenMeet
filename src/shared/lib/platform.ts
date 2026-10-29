/** True when the webview runs on macOS. Read at call time so tests can stub `navigator`. */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}

export function primaryModifierPressed(event: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** Name of the OS credential store, for user-facing text. */
export function credentialStoreName(): string {
  return isMac() ? "Keychain" : "Windows Credential Manager";
}
