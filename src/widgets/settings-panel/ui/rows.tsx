import type { ReactNode } from "react";
import { Saved } from "../../../shared/ui/settings-link";
import { Tip } from "../../../shared/ui/info-tip";

/**
 * The ⓘ now lives in shared/ui so every slice can use it. It is re-exported here because that
 * is where other slices imported it from.
 */
export { Tip };

/** A labelled settings group: everything under one small uppercase label. */
export function Group(props: {
  label: string;
  tip?: string;
  /** Shows the brief "Saved" tick after an autosaved change in this group. */
  saved?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="om-group" aria-label={props.label}>
      <span className="om-group-label">
        {props.label}
        {props.tip && <Tip text={props.tip} label={props.label} />}
        {props.saved && <Saved show />}
      </span>
      {props.children}
    </section>
  );
}

/** The card that holds rows. */
export function Rows(props: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`om-card om-rows${props.className ? ` ${props.className}` : ""}`}
    >
      {props.children}
    </div>
  );
}

/** One label and control line. `detail` is the second, muted line under the label. */
export function Row(props: {
  label: string;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="om-row">
      <div className="om-what">
        <strong>{props.label}</strong>
        {props.detail}
      </div>
      {props.children && <div className="om-side">{props.children}</div>}
    </div>
  );
}

/** The action strip attached under a card of rows. */
export function CardFoot(props: { children: ReactNode }) {
  return <div className="om-card-foot">{props.children}</div>;
}

/** An on/off switch: the label is the accessible name, so the row text stays short. */
export function Switch(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="om-switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

export type Segment<T extends string> = {
  id: T;
  title: string;
  /** Micro-note under the title, at most a few words. */
  note?: string;
  /** Renders the cloud warning tag instead of a note. */
  leaves?: boolean;
};

/** A segmented choice: the picked option is pressed, the rest are not. */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: Segment<T>[];
  disabled?: boolean;
  onChange: (id: T) => void;
}) {
  return (
    <div className="om-seg" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={props.value === option.id}
          disabled={props.disabled}
          onClick={() => props.onChange(option.id)}
        >
          <span className="om-seg-t">{option.title}</span>
          {option.leaves ? (
            <span className="om-leaves">Leaves this device</span>
          ) : (
            option.note && <span className="om-seg-s">{option.note}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** An explanation kept behind "More options" so the page stays short. */
export function More(props: { children: ReactNode; summary?: string }) {
  return (
    <details className="om-more">
      <summary>{props.summary ?? "More options"}</summary>
      <div className="om-more-body">{props.children}</div>
    </details>
  );
}
