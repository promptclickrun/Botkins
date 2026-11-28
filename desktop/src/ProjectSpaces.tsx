// A project's "Spaces and panels", when the computer has Spaces: the spaces attached to the project
// as rows, then the single panels attached to it on the grid. Attach makes a new panel or space, or
// ticks one of the person's spaces. Projects are the owner's, so a member never sees this.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Plus } from "lucide-react";
import { NewPanel, SpaceIcon } from "./SpacePage";
import { useAsk } from "./Pages";
import { attachable, spaceLine, spaceName } from "./spaces";
import type { Project, State } from "./types";
import "./spaces.css";

const api = window.botkins;

export default function ProjectSpaces({
  state,
  project,
  panels,
  openSpace,
  openNew,
  fail,
}: {
  state: State;
  project: Project;
  /** The project's single panels, drawn as the Panels section draws them. */
  panels: ReactNode;
  openSpace: (id: string) => void;
  /** Opens a chat the computer just made. */
  openNew: (chatId: string) => void;
  fail: (e: unknown) => void;
}) {
  const spaces = state.spaces ?? [];
  const projectHost = project.hostId ?? "local";
  const attached = spaces.filter((s) => s.projectId === project.id);
  const choices = attachable(spaces, project.id).filter((s) => !s.merged && (s.hostId ?? "local") === projectHost);
  const today = spaces.find((s) => s.builtin === "today" && s.mine);
  const projectBot = state.bots.find((b) => (b.hostId ?? "local") === projectHost) ?? state.bots[0];
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const dialogs = useAsk();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The menu closes on a press elsewhere and on Escape, and gives focus back to Attach.
  useEffect(() => {
    if (!menu) return;
    box.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menu]);
  function close() {
    setMenu(false);
    button.current?.focus();
  }
  async function newSpace() {
    setMenu(false);
    const name = await dialogs.ask({ title: "New space", confirm: "Create", field: { label: "Name", value: "", max: 40 } });
    if (!name) return;
    const id = await api["spaces.create"]({ name, ...(state.remote?.unified && { hostId: projectHost }) } as { name: string });
    await api["spaces.setProject"](id, project.id);
    openSpace(id);
  }
  return (
    <div className="project-spaces">
      <div className="project-spaces-head">
        <span className="project-attach-anchor">
          <button
            ref={button}
            className="primary space-add"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Plus size={16} />
            Attach
          </button>
          {menu && (
            <div
              ref={box}
              className="project-attach"
              role="menu"
              aria-label="Attach"
              onKeyDown={(e) => {
                const items = [...box.current!.querySelectorAll<HTMLElement>("[role^=menuitem]")];
                const at = items.indexOf(document.activeElement as HTMLElement);
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }
              }}
            >
              <button
                role="menuitem"
                disabled={!today}
                onClick={() => {
                  setMenu(false);
                  setAdding(true);
                }}
              >
                <Plus size={16} aria-hidden="true" />
                New panel…
              </button>
              <button role="menuitem" onClick={() => void newSpace().catch(fail)}>
                <Plus size={16} aria-hidden="true" />
                New space…
              </button>
              {choices.length > 0 && (
                <>
                  <hr />
                  <div className="project-attach-heading" role="presentation" id={"attach-" + project.id}>
                    Attach a space
                  </div>
                  <div role="group" aria-labelledby={"attach-" + project.id}>
                    {choices.map((s) => {
                      const on = s.projectId === project.id;
                      return (
                        <button
                          key={s.id}
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => void api["spaces.setProject"](s.id, on ? null : project.id).catch(fail)}
                        >
                          <span className={"project-tick" + (on ? " on" : "")} aria-hidden="true">
                            {on && <Check size={11} strokeWidth={3.2} />}
                          </span>
                          {spaceName(s)}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </span>
      </div>
      {attached.length > 0 && (
        <section className="space-group project-space-list" aria-label="Spaces">
          <ul>
            {attached.map((s) => (
              <li key={s.id}>
                <button className="space-row" onClick={() => openSpace(s.id)}>
                  <span className="space-tile">
                    <SpaceIcon space={s} size={17} />
                  </span>
                  <span className="space-row-text">
                    <strong>{spaceName(s)}</strong>
                    <small>{spaceLine(s)}</small>
                  </span>
                  {s.changed > 0 && <i className="space-dot" aria-label="Changed" />}
                  <ChevronRight size={16} className="space-row-go" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {panels}
      {adding && today && (
        <NewPanel
          state={state}
          space={today}
          botId={projectBot?.id ?? ""}
          close={() => setAdding(false)}
          opened={(chatId) => {
            setAdding(false);
            openNew(chatId);
          }}
        />
      )}
      {dialogs.node}
    </div>
  );
}
