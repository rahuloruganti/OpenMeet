// Replaces @tauri-apps/api/core in the Python build (aliased in py/vite.py.config.ts).
// invoke() posts the arguments to the local Python server. Errors arrive as the {code, message}
// object the Rust AppError serializes to, which src/lib/api.ts already reads.

declare global {
  interface Window {
    __OPENMEET_TOKEN__?: string;
  }
}

const token = (): string => (typeof window !== "undefined" ? window.__OPENMEET_TOKEN__ ?? "" : "");

export function isTauri(): boolean {
  return true;
}

/** Audio and other local files go through the server's /files route, which allows only the audio and export folders. */
export function convertFileSrc(path: string, _protocol = "asset"): string {
  return `/files?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token())}`;
}

export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenMeet-Token": token() },
      body: JSON.stringify(args),
    });
  } catch {
    throw { code: "network", message: "The local OpenMeet server did not respond." };
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    throw body ?? { code: "http", message: `The request failed with status ${response.status}.` };
  }
  return body as T;
}
