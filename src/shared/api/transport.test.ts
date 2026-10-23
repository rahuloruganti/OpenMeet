import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "test-token";

type Transport = typeof import("./transport");

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState: number = FakeSocket.CONNECTING;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

/** A fetch response stub: the transport only reads `ok`, `status` and `text()`. */
const response = (status: number, body: string): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
let transport: Transport;

beforeEach(async () => {
  vi.resetModules();
  FakeSocket.instances = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeSocket);
  window.__OPENMEET_TOKEN__ = TOKEN;
  transport = await import("./transport");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.__OPENMEET_TOKEN__;
});

describe("invoke", () => {
  it("posts the command and its arguments with the token header", async () => {
    fetchMock.mockResolvedValue(response(200, '{"revision":4}'));
    const args = { id: "m", markdown: "# notes", expectedRevision: 3 };
    await expect(transport.invoke("save_notes", args)).resolves.toEqual({
      revision: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/invoke/save_notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenMeet-Token": TOKEN,
      },
      body: JSON.stringify(args),
    });
  });

  it("sends an empty object when a command takes no arguments", async () => {
    fetchMock.mockResolvedValue(response(200, "null"));
    await expect(transport.invoke("get_settings")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/invoke/get_settings",
      expect.objectContaining({ body: "{}" }),
    );
  });

  it("rethrows the backend's {code, message} body", async () => {
    fetchMock.mockResolvedValue(
      response(409, '{"code":"stale_notes","message":"The notes changed."}'),
    );
    await expect(transport.invoke("save_notes")).rejects.toEqual({
      code: "stale_notes",
      message: "The notes changed.",
    });
  });

  it("reports an error status with no JSON body as http", async () => {
    fetchMock.mockResolvedValue(response(400, "Bad Request"));
    await expect(transport.invoke("save_notes")).rejects.toEqual({
      code: "http",
      message: "The request failed with status 400.",
    });
  });

  it("reports an unreachable server as a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(transport.invoke("list_meetings")).rejects.toEqual({
      code: "network",
      message: "The local OpenMeet server did not respond.",
    });
  });
});

describe("convertFileSrc", () => {
  it("routes the file through /files with an encoded path and the token", () => {
    const path = "C:\\Users\\Rahul\\AppData\\audio & export\\take one.wav";
    expect(transport.convertFileSrc(path)).toBe(
      `/files?path=${encodeURIComponent(path)}&token=${TOKEN}`,
    );
    expect(transport.convertFileSrc(path)).toContain("%20");
  });
});

describe("listen", () => {
  it("opens one token-carrying socket and dispatches to the matching listener", async () => {
    const callback = vi.fn();
    await transport.listen("recording_state", callback);
    await transport.listen("stt_progress", vi.fn());

    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe(`ws://${location.host}/ws?token=${TOKEN}`);

    socket.readyState = FakeSocket.OPEN;
    socket.onmessage?.({
      data: JSON.stringify({
        event: "recording_state",
        payload: { revision: 9 },
      }),
    } as MessageEvent<string>);

    expect(callback).toHaveBeenCalledExactlyOnceWith({
      event: "recording_state",
      id: 1,
      payload: { revision: 9 },
    });
  });

  it("ignores frames that are not JSON events", async () => {
    const callback = vi.fn();
    await transport.listen("recording_state", callback);
    const socket = FakeSocket.instances[0]!;

    socket.onmessage?.({ data: "not json" } as MessageEvent<string>);
    socket.onmessage?.({
      data: JSON.stringify({ payload: 1 }),
    } as MessageEvent<string>);

    expect(callback).not.toHaveBeenCalled();
  });

  it("stops dispatch once the unsubscribe function runs", async () => {
    const callback = vi.fn();
    const stop = await transport.listen("recording_state", callback);
    const socket = FakeSocket.instances[0]!;
    const frame = {
      data: JSON.stringify({ event: "recording_state", payload: null }),
    } as MessageEvent<string>;

    socket.onmessage?.(frame);
    expect(callback).toHaveBeenCalledTimes(1);

    stop();
    socket.onmessage?.(frame);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("isBackendConnected", () => {
  it("is true only while the served page carries a token", () => {
    expect(transport.isBackendConnected()).toBe(true);
    window.__OPENMEET_TOKEN__ = "";
    expect(transport.isBackendConnected()).toBe(false);
    delete window.__OPENMEET_TOKEN__;
    expect(transport.isBackendConnected()).toBe(false);
  });
});
