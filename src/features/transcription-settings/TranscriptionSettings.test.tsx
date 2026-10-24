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
  const engine = screen.getByRole("group", { name: "Runs" });
  await userEvent.click(screen.getByRole("button", { name: /Cloud/ }));
  expect(input.onMode).toHaveBeenCalledWith("cloud");
  expect(engine).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Spoken language"), "de");
  expect(input.onSave).toHaveBeenCalledWith({
    stt_language: "de",
    stt_prompt: "",
    stt_model: "small",
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Use Whisper base" }),
  );
  expect(input.onSave).toHaveBeenLastCalledWith({
    stt_language: "auto",
    stt_prompt: "",
    stt_model: "base",
  });
});

it("marks the model in use and totals the disk it takes", () => {
  render(<TranscriptionSettings {...props()} />);
  expect(screen.getByText("In use")).toBeTruthy();
  expect(screen.getByText("608.0 MB on disk")).toBeTruthy();
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

it("offers the engine download only while it is missing", async () => {
  const input = props();
  const view = render(
    <TranscriptionSettings {...input} stt={{ ...stt, installed: false }} />,
  );
  expect(screen.getByText("Not installed")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Download models" }),
  );
  expect(input.onInstall).toHaveBeenCalledOnce();
  view.unmount();
  render(<TranscriptionSettings {...input} />);
  expect(screen.getByText("Installed and verified")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
});

it("mounts the model library only when Get models is opened", async () => {
  const input = props();
  render(<TranscriptionSettings {...input} library={<p>model library</p>} />);
  expect(screen.queryByText("model library")).toBeNull();
  const get = screen.getByRole("button", { name: "Get models" });
  await userEvent.click(get);
  expect(screen.getByText("model library")).toBeTruthy();
  expect(get.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(get);
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
  // The engine option and the connection header both carry the disclosure.
  expect(screen.getAllByText("Leaves this device")).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Connection" })).toBeTruthy();
  expect(screen.queryByText("Cloud speech")).toBeNull();
  expect(screen.queryByLabelText("Spoken language")).toBeNull();
  expect(screen.queryByRole("button", { name: "Get models" })).toBeNull();
});

it("says the engine is unsupported on this platform", () => {
  render(
    <TranscriptionSettings
      {...props()}
      stt={{ ...stt, installed: false, supported: false }}
    />,
  );
  expect(screen.getByText("Not supported on this platform yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download models" })).toBeNull();
});
