// The Python backend is the only transport for the UI. invoke() posts to /api/invoke/<cmd>; the
// audio and export files come from /files; every event listener shares one WebSocket at /ws.
// The server injects window.__OPENMEET_TOKEN__ into the page it serves, so the same token guards
// every route. Errors arrive as the {code, message} object the backend serializes.

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;

type Listener = EventCallback<unknown>;

declare global {
  interface Window {
    __OPENMEET_TOKEN__?: string;
  }
}

const token = (): string =>
  typeof window === "undefined" ? "" : (window.__OPENMEET_TOKEN__ ?? "");

/** True once the backend has served the page and injected its token; false in a plain tab. */
export function isBackendConnected(): boolean {
  return token().length > 0;
}

/** Audio and other local files go through the server's /files route; it serves only known folders. */
export function convertFileSrc(path: string): string {
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
      headers: {
        "Content-Type": "application/json",
        "X-OpenMeet-Token": token(),
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw {
      code: "network",
      message: "The local OpenMeet server did not respond.",
    };
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
    throw (
      body ?? {
        code: "http",
        message: `The request failed with status ${response.status}.`,
      }
    );
  }
  return body as T;
}

const listeners = new Map<string, Map<number, Listener>>();
let nextId = 1;
let socket: WebSocket | null = null;

function dispatch(message: MessageEvent<string>): void {
  let data: { event?: unknown; payload?: unknown };
  try {
    data = JSON.parse(message.data) as { event?: unknown; payload?: unknown };
  } catch {
    return;
  }
  if (typeof data.event !== "string") return;
  for (const [id, callback] of listeners.get(data.event) ?? []) {
    callback({ event: data.event, id, payload: data.payload });
  }
}

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${scheme}://${location.host}/ws?token=${encodeURIComponent(token())}`,
  );
  ws.onmessage = dispatch;
  ws.onclose = () => {
    socket = null;
    // Reconnect while anything listens; events missed while closed are re-read by the UI on focus.
    if (listeners.size > 0) setTimeout(connect, 1000);
  };
  socket = ws;
}

export async function listen<T = unknown>(
  event: string,
  callback: EventCallback<T>,
): Promise<() => void> {
  connect();
  const id = nextId++;
  if (!listeners.has(event)) listeners.set(event, new Map());
  listeners.get(event)!.set(id, callback as Listener);
  return () => {
    listeners.get(event)?.delete(id);
  };
}
