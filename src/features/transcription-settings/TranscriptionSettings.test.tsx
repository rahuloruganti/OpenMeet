import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Settings, SttStatus } from "../../shared/api/api";
import { TranscriptionSettings } from "./TranscriptionSettings";
const settings = {
  stt_mode: "local",
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
} as unknown as Settings;
const stt: SttStatus = {
  engine: true,
  model: true,
  vad: true,
  installed: true,
  missing_bytes: 0,
  supported: true,
  models: [
    { id: "small", size: 466 * 1024 * 1024, installed: true },
    { id: "base", size: 142 * 1024 * 1024, installed: true },
  ],
  languages: ["auto", "en", "de"],
};
const props = (input: Settings = settings) => ({
  settings: input,
  disabled: false,
  stt,
  sttProgress: null,
  installing: false,
  onMode: vi.fn(),
  onInstall: vi.fn(),
  onCancel: vi.fn(),
  onSave: vi.fn(),
});
beforeEach(() => vi.resetAllMocks());

it("saves the engine choice, the language and the model as they change", async () => {
  const input = props();
  render(<TranscriptionSettings {...input} />);
  const engine = screen.getByRole("group", { name: "Process audio" });
  await userEvent.click(screen.getByRole("button", { name: /Cloud/ }));
  expect(input.onMode).toHaveBeenCalledWith("cloud");
  expect(engine).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Spoken language"), "de");
  expect(input.onSave).toHaveBeenCalledWith({
    stt_language: "de",
    stt_prompt: "",
    stt_model: "small",
  });
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Speech model" }),
    "base",
  );
  expect(input.onSave).toHaveBeenLastCalledWith({
    stt_language: "auto",
    stt_prompt: "",
    stt_model: "base",
  });
});

it("selects the model in use and totals the disk it takes", () => {
  render(<TranscriptionSettings {...props()} />);
  const menu = screen.getByRole("combobox", { name: "Speech model" });
  expect((menu as HTMLSelectElement).value).toBe("small");
  expect(screen.getByText("608.0 MB on disk")).toBeTruthy();
});

const optionIds = () =>
  Array.from(
    (
      screen.getByRole("combobox", {
        name: "Speech model",
      }) as HTMLSelectElement
    ).options,
  )
    .filter((option) => !option.disabled)
    .map((option) => option.value);

it("lists only models on this PC that can run and fit the spoken language", () => {
  const mixed: SttStatus = {
    ...stt,
    models: [
      { id: "small", size: 10, installed: true },
      { id: "base.en", size: 10, installed: true },
      { id: "medium", size: 10, installed: false },
      { id: "sherpa:parakeet-v3", size: 10, installed: true },
      { id: "sherpa:moonshine-base-en", size: 10, installed: true },
      {
        id: "sherpa:sense-voice",
        size: 10,
        installed: true,
        reason: "Engine missing",
      },
    ],
  };
  const german = { ...settings, stt_language: "de" } as Settings;
  render(
    <TranscriptionSettings
      {...props(german)}
      stt={mixed}
      localFiles={[
        {
          path: "D:/models/ggml-large-v3.bin",
          format: "whisper",
          size: 20,
          model_id: null,
        },
        {
          path: "D:/models/ggml-tiny.en.bin",
          format: "whisper",
          size: 5,
          model_id: null,
        },
        {
          path: "D:/models/chat.gguf",
          format: "gguf",
          size: 30,
          model_id: null,
        },
        {
          path: "D:/models/notes.bin",
          format: "unknown",
          size: 1,
          model_id: null,
        },
      ]}
    />,
  );
  expect(optionIds()).toEqual([
    "small",
    "sherpa:parakeet-v3",
    "D:/models/ggml-large-v3.bin",
  ]);
});

it("offers English-only models when the language is English or detected", () => {
  const english: SttStatus = {
    ...stt,
    models: [
      { id: "small", size: 10, installed: true },
      { id: "base.en", size: 10, installed: true },
      { id: "sherpa:moonshine-base-en", size: 10, installed: true },
    ],
  };
  render(<TranscriptionSettings {...props()} stt={english} />);
  expect(optionIds()).toEqual(["small", "base.en", "sherpa:moonshine-base-en"]);
});

it("skips a found file that duplicates an installed catalog model", () => {
  render(
    <TranscriptionSettings
      {...props()}
      localFiles={[
        {
          path: "C:/cache/ggml-small.bin",
          format: "whisper",
          size: 466,
          model_id: "small",
        },
      ]}
    />,
  );
  expect(optionIds()).toEqual(["small", "base"]);
});

it("saves a found Whisper file by its path", async () => {
  const input = props();
  render(
    <TranscriptionSettings
      {...input}
      localFiles={[
        {
          path: "D:/models/ggml-large-v3.bin",
          format: "whisper",
          size: 20,
          model_id: null,
        },
      ]}
    />,
  );
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Speech model" }),
    "D:/models/ggml-large-v3.bin",
  );
  expect(input.onSave).toHaveBeenLastCalledWith({
    stt_language: "auto",
    stt_prompt: "",
    stt_model: "D:/models/ggml-large-v3.bin",
  });
});

it("says why the saved model is not offered", () => {
  const view = render(
    <TranscriptionSettings
      {...props({
        ...settings,
        stt_language: "de",
        stt_model: "base.en",
      } as Settings)}
      stt={{
        ...stt,
        models: [...stt.models, { id: "base.en", size: 10, installed: true }],
      }}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Doesn't fit the spoken language. Pick another.",
  );
  expect(optionIds()).not.toContain("base.en");
  view.unmount();
  render(
    <TranscriptionSettings
      {...props({ ...settings, stt_model: "medium" } as Settings)}
      stt={{ ...stt, model: false }}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Not available on this PC. Pick another or download one.",
  );
});

it("saves the vocabulary hint when the field loses focus", async () => {
  const input = props();
  render(<TranscriptionSettings {...input} />);
  const summary = screen.getByText("More options");
  await userEvent.click(summary);
  const hint = screen.getByLabelText("Vocabulary hint");
  await userEvent.type(hint, "Okta");
  expect(input.onSave).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(input.onSave).toHaveBeenCalledWith({
    stt_language: "auto",
    stt_prompt: "Okta",
    stt_model: "small",
  });
});

it("mounts the own-model library only when Add your own model is opened", async () => {
  const input = props();
  render(<TranscriptionSettings {...input} library={<p>model library</p>} />);
  await userEvent.click(screen.getByText("More options"));
  expect(screen.queryByText("model library")).toBeNull();
  const add = screen.getByRole("button", { name: "Add your own model" });
  await userEvent.click(add);
  expect(screen.getByText("model library")).toBeTruthy();
  expect(add.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(add);
  expect(screen.queryByText("model library")).toBeNull();
});

it("shows the cloud connection card and no local options on cloud", () => {
  render(
    <TranscriptionSettings
      {...props({ ...settings, stt_mode: "cloud" } as Settings)}
      cloudForm={<p>cloud form</p>}
    />,
  );
  expect(screen.getByText("cloud form")).toBeTruthy();
  // Neither the engine option nor the connection header carries a leaving-the-device tag.
  expect(screen.queryByText("Leaves this device")).toBeNull();
  expect(screen.getByRole("region", { name: "Connection" })).toBeTruthy();
  expect(screen.queryByText("Cloud speech")).toBeNull();
  expect(screen.queryByLabelText("Spoken language")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Add your own model" }),
  ).toBeNull();
});

it("says the engine is unsupported on this platform", () => {
  render(
    <TranscriptionSettings
      {...props()}
      stt={{ ...stt, installed: false, supported: false }}
    />,
  );
  expect(screen.getByText("Not supported on this platform yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

it("shows one Ready speech model when the model is downloaded", () => {
  render(<TranscriptionSettings {...props()} />);
  expect(screen.getByText("Ready")).toBeTruthy();
  expect(screen.getByText("Available")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  expect(screen.queryByText("Other models")).toBeNull();
});

it("offers one Download with its size for the chosen model when it is not downloaded", async () => {
  const input = props();
  render(
    <TranscriptionSettings
      {...input}
      stt={{
        ...stt,
        installed: false,
        model: false,
        missing_bytes: 466 * 1024 * 1024,
        models: [{ id: "small", size: 466 * 1024 * 1024, installed: false }],
      }}
    />,
  );
  expect(screen.getByText("Not downloaded · 466.0 MB")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(input.onInstall).toHaveBeenCalledOnce();
  expect(input.onSave).not.toHaveBeenCalled();
});

it("downloads the recommended model when no speech model is chosen", async () => {
  const input = props({ ...settings, stt_model: "" } as Settings);
  render(
    <TranscriptionSettings
      {...input}
      onDownload={vi.fn()}
      stt={{
        ...stt,
        installed: false,
        model: false,
        models: [
          { id: "small", size: 466 * 1024 * 1024, installed: false },
          { id: "base", size: 142 * 1024 * 1024, installed: false },
        ],
      }}
    />,
  );
  expect(screen.getByText("Not downloaded · 466.0 MB")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(input.onInstall).not.toHaveBeenCalled();
  expect(screen.getByText("Other models")).toBeTruthy();
});

it("shows the download as a percentage with one Cancel while it runs", async () => {
  const input = props();
  render(
    <TranscriptionSettings
      {...input}
      installing
      sttProgress={{
        stage: "model",
        downloaded: 100 * 1024 * 1024,
        total: 465 * 1024 * 1024,
      }}
      stt={{ ...stt, installed: false }}
    />,
  );
  expect(screen.getByText("Downloading 22%")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input.onCancel).toHaveBeenCalledOnce();
});

it("shows the reason next to a disabled Download", () => {
  render(
    <TranscriptionSettings
      {...props({ ...settings, stt_model: "" } as Settings)}
      disabled
      onDownload={vi.fn()}
      stt={{
        ...stt,
        installed: false,
        model: false,
        models: [{ id: "small", size: 466 * 1024 * 1024, installed: false }],
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Download" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.getAllByText("Wait for the current task to finish.").length,
  ).toBeGreaterThan(0);
});

it("names the processing choice plainly", () => {
  render(<TranscriptionSettings {...props()} />);
  expect(screen.getByRole("group", { name: "Process audio" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Runs" })).toBeNull();
  expect(screen.getByRole("button", { name: /On this PC/ })).toBeTruthy();
  expect(screen.getByText("Audio stays here")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Cloud/ })).toBeTruthy();
  expect(screen.queryByText("Runs")).toBeNull();
  expect(screen.queryByText("Install")).toBeNull();
  expect(screen.queryByText("Catalog")).toBeNull();
});

it("offers the engine as status only, with no separate download", () => {
  render(
    <TranscriptionSettings
      {...props()}
      stt={{ ...stt, installed: false, supported: false }}
    />,
  );
  expect(screen.getByText("Not supported on this platform yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

it("offers other catalog models under Other models, only those that run here and fit the language", async () => {
  const onDownload = vi.fn();
  const catalog: SttStatus = {
    ...stt,
    models: [
      { id: "small", size: 10, installed: true },
      { id: "medium", size: 1500, installed: false },
      { id: "base.en", size: 140, installed: false },
      {
        id: "sherpa:sense-voice",
        size: 230,
        installed: false,
        reason: "Engine missing",
      },
    ],
  };
  const german = { ...settings, stt_language: "de" } as Settings;
  render(
    <TranscriptionSettings
      {...props(german)}
      stt={catalog}
      onDownload={onDownload}
    />,
  );
  await userEvent.click(screen.getByText("Other models"));
  const buttons = screen.getAllByRole("button", { name: /^Download / });
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Download Whisper medium",
  ]);
  await userEvent.click(buttons[0]);
  expect(onDownload).toHaveBeenCalledWith({
    stt_language: "de",
    stt_prompt: "",
    stt_model: "medium",
  });
});

it("hides Other models when everything that fits is already downloaded", () => {
  render(<TranscriptionSettings {...props()} onDownload={vi.fn()} />);
  expect(screen.queryByText("Other models")).toBeNull();
});
