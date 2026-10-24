import {
  api,
  isLocalBase,
  type KeyStatus,
  type ProviderRole,
  type Settings,
} from "../api/api";

export type Publish = {
  onSaved: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
};

/** Hands saved settings to App and refreshes both tasks' key status. */
export async function publishSettings(settings: Settings, to: Publish) {
  to.onSaved(settings);
  for (const role of ["llm", "cloud_stt"] satisfies ProviderRole[]) {
    try {
      to.onKeyStatus(role, await api.providerKeyStatus(role));
    } catch {
      to.onKeyStatus(role, "unavailable");
    }
  }
}

/** Where a URL sends data, as plain text: the host (with its port when it has one). */
export const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl.trim()).host || baseUrl.trim();
  } catch {
    return baseUrl.trim();
  }
};

/** Badge text for a connection: loopback stays on this device. */
export const destination = (baseUrl: string) =>
  isLocalBase(baseUrl) ? "This device" : "Leaves this device";
