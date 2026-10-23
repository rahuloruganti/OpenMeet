// Replaces @tauri-apps/api/event in the Python build (aliased in py/vite.py.config.ts).
// All listeners share one WebSocket to the local server. Each message is {event, payload}.

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;

type Listener = (event: Event<unknown>) => void;

const token = (): string =>
  typeof window !== "undefined" ? (window as Window & { __OPENMEET_TOKEN__?: string }).__OPENMEET_TOKEN__ ?? "" : "";
const listeners = new Map<string, Map<number, Listener>>();
let nextId = 1;
let socket: WebSocket | null = null;

function dispatch(message: MessageEvent<string>): void {
  let data: { event?: unknown; payload?: unknown };
  try {
    data = JSON.parse(message.data);
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
  const ws = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token())}`);
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
