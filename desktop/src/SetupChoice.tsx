// The first launch's first question: run bots on this computer, use another computer's Botkins,
// or join a team. "Set up on this computer" goes on to the welcome (src/Welcome.tsx) and the first
// bot (src/FirstBot.tsx); the other two are steps here that end with the window using that computer.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, CircleAlert, Monitor, MonitorSmartphone, Users } from "lucide-react";
import { WelcomeFrame } from "./Welcome";
import { PairForm, TeamJoin } from "./RemoteHosts";
import { errorText } from "./SettingsRows";
import "./settings.css";
import "./remotehosts.css";

const api = window.botkins;

export type SetupPath = "here" | "computer" | "team";

const CHOICES: { id: SetupPath; title: string; line: string; icon: ReactNode }[] = [
  { id: "here", title: "Set up on this computer", line: "Your bots run here. Sign in to a model provider, then make your first bot.", icon: <Monitor size={22} /> },
  { id: "computer", title: "Connect to another computer", line: "Use the Botkins on another computer or a server. Paste its pairing link or code.", icon: <MonitorSmartphone size={22} /> },
  { id: "team", title: "Join a team", line: "Use a team's bots with the invite code its owner sent you.", icon: <Users size={22} /> },
];
const FOOT = "You can change this later in Settings › Computers and teams.";

/** The step's Back button, at the top of its card. */
function SetupBack({ back }: { back: () => void }) {
  return (
    <button type="button" className="welcome-later welcome-back" onClick={back}>
      <ArrowLeft size={14} aria-hidden="true" />
      Back
    </button>
  );
}

/** The three ways to use Botkins here, as three large buttons. */
export default function SetupChoice({ choose }: { choose: (path: SetupPath) => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  // Focus rests on the title, so no choice is picked ahead.
  useEffect(() => title.current?.focus(), []);
  return (
    <WelcomeFrame label="setup-title">
      <div className="welcome-card setup-card">
        <h1 id="setup-title" ref={title} tabIndex={-1}>
          Welcome to Botkins
        </h1>
        <p className="welcome-lede">How do you want to use Botkins here?</p>
        <ul className="setup-choices" aria-label="Ways to use Botkins">
          {CHOICES.map((c) => (
            <li key={c.id}>
              <button type="button" className={"setup-choice " + c.id} onClick={() => choose(c.id)}>
                <span className="setup-choice-icon" aria-hidden="true">
                  {c.icon}
                </span>
                <span className="setup-choice-text">
                  <strong>{c.title}</strong>
                  <small>{c.line}</small>
                </span>
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <p className="welcome-foot">{FOOT}</p>
      </div>
    </WelcomeFrame>
  );
}

/**
 * The end of the other-computer and team steps: `done` uses that computer (or team) and marks the
 * first run finished, so the window opens on its bots. A failure is kept in `problem` for the step to show.
 */
function useFinish() {
  const [problem, setProblem] = useState("");
  const done = async (hostId: string) => {
    setProblem("");
    try {
      await api.useRemoteHost(hostId);
      await api.setPreferences({ onboarded: true });
    } catch (e) {
      setProblem(errorText(e));
      throw e;
    }
  };
  return { problem, done };
}

function Problem({ text }: { text: string }) {
  return text ? (
    <div className="welcome-problem" role="alert">
      <CircleAlert size={16} />
      <span>{text}</span>
    </div>
  ) : null;
}

/** Connect to another computer: its pairing link (or address and code), then the window uses it. */
export function SetupConnect({ back }: { back: () => void }) {
  const { problem, done } = useFinish();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <WelcomeFrame label="setup-connect-title">
      <div className="welcome-card setup-card">
        <SetupBack back={back} />
        <h1 id="setup-connect-title" ref={title} tabIndex={-1}>
          Connect to another computer
        </h1>
        <p className="welcome-lede">Use the bots and chats on another computer or a server from this window.</p>
        <div className="setup-step">
          <PairForm
            paired={async (host) => {
              // The pairing is kept even if using it fails: it is listed in Settings › Computers and teams.
              await done(host.id).catch(() => {});
            }}
          />
        </div>
        <Problem text={problem} />
        <p className="welcome-foot">{FOOT}</p>
      </div>
    </WelcomeFrame>
  );
}

/** Join a team: the invite code or link, the owner's approval, then the window uses the team. */
export function SetupTeam({ back, initialJoin }: { back: () => void; initialJoin?: string }) {
  const { problem, done } = useFinish();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <WelcomeFrame label="setup-team-title">
      <div className="welcome-card setup-card">
        <SetupBack back={back} />
        <h1 id="setup-team-title" ref={title} tabIndex={-1}>
          Join a team
        </h1>
        <p className="welcome-lede">Use a team's bots with the invite code its owner sent you. The owner approves the request.</p>
        <div className="setup-step">
          <TeamJoin initialJoin={initialJoin} approved={(id) => void done(id).catch(() => {})} />
        </div>
        <Problem text={problem} />
        <p className="welcome-foot">{FOOT}</p>
      </div>
    </WelcomeFrame>
  );
}
