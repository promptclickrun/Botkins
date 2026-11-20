import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./settings.css";

/** A main-process error as a sentence: drops Electron's "Error invoking remote method …" prefix. */
export function errorText(e: unknown) {
  return String(e instanceof Error ? e.message : e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/**
 * A sheet over Settings, drawn like Create a bot: a title, a form and a sticky footer of buttons.
 * Escape closes only the sheet, not the Settings window under it.
 */
export function Sheet({
  title,
  close,
  submit,
  footer,
  wide,
  children,
}: {
  title: string;
  close: () => void;
  submit: () => void;
  footer: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={"bot-sheet int-sheet" + (wide ? " wide" : "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <div className="sectionhead">
        <h2>{title}</h2>
      </div>
      <form
        className="botform"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {children}
        <footer className="botform-foot">{footer}</footer>
      </form>
    </dialog>,
    document.body,
  );
}

/** A titled card of settings rows separated by hairlines, like a grouped list in System Settings. */
export function Group({
  title,
  footer,
  children,
  actions,
}: {
  title?: string;
  /** Help text under the card. */
  footer?: ReactNode;
  /** Buttons along the bottom edge of the card, right-aligned. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="set-group">
      {title && <h3>{title}</h3>}
      <div className="set-card">
        {children}
        {actions && <div className="set-actions">{actions}</div>}
      </div>
      {footer && <p className="set-foot">{footer}</p>}
    </section>
  );
}

/**
 * One row: label and help on the left, the control on the right.
 * `children` receives the control's id and the help text's id so the label and description attach to it.
 * `stacked` puts a wide control (a text area or picker) under the label instead.
 */
export function Row({
  label,
  help,
  stacked,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  stacked?: boolean;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const helpId = help ? id + "-help" : undefined;
  return (
    <div className={"set-row" + (stacked ? " stacked" : "")}>
      <div className="set-label">
        <label htmlFor={id}>{label}</label>
        {help && <small id={helpId}>{help}</small>}
      </div>
      <div className="set-control">{children(id, helpId)}</div>
    </div>
  );
}

/** A row whose right side is plain text, such as a version number or a size. */
export function ValueRow({ label, value, help }: { label: ReactNode; value: ReactNode; help?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{label}</span>
        {help && <small>{help}</small>}
      </div>
      <div className="set-control set-value">{value}</div>
    </div>
  );
}

/** An on/off switch row. The whole label names the switch, so tests and VoiceOver read "Replies", etc. */
export function SwitchRow({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Row label={label} help={help}>
      {(id, describedBy) => (
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="switch set-switch"
          aria-describedby={describedBy}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}
    </Row>
  );
}
