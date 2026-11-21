"""Hermes profile -> Botkins bot.

Botkins offers the custom agents in the Copilot home (``$COPILOT_HOME/agents/*.agent.md``, default
``~/.copilot/agents``) under Import agents. An agent file is front matter (name, description, model)
followed by the prompt, which becomes the bot's instructions (at most 30,000 characters).

A light clone is that agent file, made from SOUL.md. A full clone adds the bot's profile files and
memory, which Botkins keeps per bot:

  SOUL.md (condensed to 4,000 characters)  -> <data>/files/<bot id>/AGENTS.md
  USER.md                                   -> <data>/files/<bot id>/USER.md
  IDENTITY.md                               -> <data>/files/<bot id>/IDENTITY.md
  memories/MEMORY.md                        -> <data>/memory/<bot id>/MEMORY.md

Hermes profiles are only read, never changed.
"""

from __future__ import annotations

import json
import os
import re
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

INSTRUCTIONS_MAX = 30000  # Botkins bot instructions
PROFILE_PROMPT_MAX = 4000  # desktop/bot-profile-files.mjs promptChars: what a turn sees of each file
PROFILE_BYTES_MAX = 64 * 1024  # desktop/bot-profile-files.mjs maxBytes
CONDENSE_TARGET = 3600
MEMORY_MAX = 24000  # desktop/memory.mjs
ENTRY_MAX = 600
DESCRIPTION_MAX = 240
NAME_MAX = 48
FILE_PREFIX = "hermes-"
PROFILE_FILES = ("AGENTS.md", "USER.md", "IDENTITY.md")
_IDENTITY_MARKERS = ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
_PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_BOT_ID = re.compile(r"^[\w-]{1,80}$")

Complete = Callable[[list], str]


@dataclass
class Profile:
    name: str
    home: Path


@dataclass
class Agent:
    profile: str
    name: str
    description: str
    model: str
    instructions: str
    truncated: bool = False

    @property
    def slug(self) -> str:
        return re.sub(r"[^a-z0-9]+", "-", self.name.lower()).strip("-") or self.profile

    @property
    def filename(self) -> str:
        # Named for the bot ("hermes-ralph"), so the file is easy to find; the profile is in the front matter.
        return FILE_PREFIX + self.slug + ".agent.md"


@dataclass
class Clone:
    """What a clone brings over. ``files`` is empty for a light clone."""

    agent: Agent
    files: dict[str, str] = field(default_factory=dict)  # AGENTS.md, USER.md, IDENTITY.md, MEMORY.md
    notes: list[str] = field(default_factory=list)

    @property
    def full(self) -> bool:
        return bool(self.files)


# Profiles ----------------------------------------------------------------------------------

def hermes_root() -> Path:
    """The Hermes root (the default profile's home), even when run inside a named profile."""
    try:
        from hermes_constants import get_default_hermes_root

        root = Path(get_default_hermes_root())
    except Exception:
        root = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    # A named profile's home is <root>/profiles/<name>.
    if root.parent.name == "profiles":
        root = root.parent.parent
    return root


def list_profiles(root: Path | None = None) -> list[Profile]:
    root = root or hermes_root()
    found = [Profile("default", root)] if (root / "config.yaml").exists() or (root / "SOUL.md").exists() else []
    profiles_dir = root / "profiles"
    deleted = profiles_dir / ".deleted"
    if profiles_dir.is_dir():
        for home in sorted(profiles_dir.iterdir()):
            if not home.is_dir() or not _PROFILE_ID.match(home.name) or (deleted / home.name).exists():
                continue
            # Runtime leftovers (cron heartbeats, snapshots) make dirs with no identity; skip them.
            if any((home / m).exists() for m in _IDENTITY_MARKERS):
                found.append(Profile(home.name, home))
    return found


def find_profile(name: str, root: Path | None = None) -> Profile:
    for profile in list_profiles(root):
        if profile.name == name:
            return profile
    raise ValueError(f"No Hermes profile named '{name}'.")


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def _profile_text(profile: Profile, file: str) -> str:
    """A profile file from its home, or from memories/ where Hermes keeps USER.md."""
    return _read(profile.home / file) or _read(profile.home / "memories" / file)


def _entries(text: str) -> list[str]:
    """Hermes memory files hold entries separated by §."""
    return [e.strip() for e in text.split("§") if e.strip()]


# Agent file --------------------------------------------------------------------------------

def _model(home: Path) -> str:
    """model.default from config.yaml, as a Copilot-style id (claude-opus-5-5[1m] -> claude-opus-5.5)."""
    text = _read(home / "config.yaml")
    value = ""
    try:
        import yaml

        model = (yaml.safe_load(text) or {}).get("model")
        value = model.get("default", "") if isinstance(model, dict) else (model or "")
    except Exception:
        match = re.search(r"^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*(\S+)", text + "\n", re.M)
        value = match.group(1) if match else ""
    value = re.sub(r"\[[^\]]*\]$", "", str(value).strip().strip("'\""))
    value = value.split("/")[-1]
    return re.sub(r"-(\d+)-(\d+)$", r"-\1.\2", value)


def _display_name(soul: str, profile: str) -> str:
    match = re.search(r"\bYou are ([A-Z][\w'-]*)", soul)
    if match:
        return match.group(1)
    heading = re.search(r"^#\s+(.+)$", soul, re.M)
    if heading and heading.group(1).strip().lower() not in {"soul", "who you are", "identity"}:
        return heading.group(1).strip()
    return profile.replace("-", " ").replace("_", " ").title()


def _description(soul: str, name: str) -> str:
    """What the agent is, from "You are <name>, a/an/the ..." in the SOUL; Botkins makes the role of it."""
    flat = " ".join(soul.split())
    match = re.search(rf"\bYou are {re.escape(name)}\s*,\s*((?:an?|the)\s[^.!?]+[.!?]?)", flat)
    if match:
        sentence = match.group(1).rstrip(".!? ")
        return (sentence[0].upper() + sentence[1:])[:DESCRIPTION_MAX].rstrip()
    return f"{name}, cloned from Hermes"


def _clean(value: str, limit: int) -> str:
    return " ".join(value.replace('"', "'").split())[:limit].strip()


def _soul(profile: Profile) -> str:
    soul = _read(profile.home / "SOUL.md")
    if not soul:
        raise ValueError(f"Profile '{profile.name}' has no SOUL.md to clone.")
    return soul


def build_agent(profile: Profile, *, name: str | None = None, description: str | None = None) -> Agent:
    soul = _soul(profile)
    display = _clean(name or _display_name(soul, profile.name), NAME_MAX)
    instructions = soul
    truncated = len(instructions) > INSTRUCTIONS_MAX
    if truncated:
        instructions = instructions[: INSTRUCTIONS_MAX - 1].rsplit("\n", 1)[0]
    return Agent(
        profile=profile.name,
        name=display,
        description=_clean(description or _description(soul, display), DESCRIPTION_MAX),
        model=_model(profile.home),
        instructions=instructions,
        truncated=truncated,
    )


def render(agent: Agent) -> str:
    lines = ["---", f'name: "{agent.name}"', f'description: "{agent.description}"']
    if agent.model:
        lines.append(f'model: "{agent.model}"')
    lines += [f'hermes-profile: "{agent.profile}"', "---", "", agent.instructions, ""]
    return "\n".join(lines)


# Full clone --------------------------------------------------------------------------------

_CONDENSE_SYSTEM = (
    "You condense an AI agent's persona file. Rewrite it as Markdown in at most {limit} characters. "
    "Keep, in the agent's own voice and in second person: its name and role, how it speaks, the rules "
    "it keeps, the people and systems it works with, and anything it must never do. Drop examples, "
    "repetition and filler before you drop a rule. Reply with the rewritten file only: no preamble, "
    "no code fence, no notes."
)


def _unfence(text: str) -> str:
    text = text.strip()
    match = re.fullmatch(r"```[\w-]*\n(.*)\n```", text, re.S)
    return match.group(1).strip() if match else text


def _cut(text: str, limit: int) -> str:
    return text[:limit].rsplit("\n", 1)[0].rstrip() if len(text) > limit else text


def condense(soul: str, complete: Complete | None) -> tuple[str, list[str]]:
    """SOUL.md as AGENTS.md: as-is when it fits Botkins' 4,000 characters, else condensed by the model."""
    if len(soul) <= PROFILE_PROMPT_MAX:
        return soul, []
    if complete is None:
        raise ValueError(f"SOUL.md has {len(soul):,} characters and needs condensing to {PROFILE_PROMPT_MAX:,} "
                         "for AGENTS.md, but no model is available here. Run it from Hermes (hermes botkins-clone).")
    limit = CONDENSE_TARGET
    messages = [{"role": "system", "content": _CONDENSE_SYSTEM.format(limit=limit)},
                {"role": "user", "content": soul}]
    text = _unfence(complete(messages))
    if len(text) > PROFILE_PROMPT_MAX:
        messages += [{"role": "assistant", "content": text},
                     {"role": "user", "content": f"That is {len(text):,} characters. Cut it to under {limit:,}."}]
        text = _unfence(complete(messages))
    if not text:
        raise ValueError("The model returned nothing when condensing SOUL.md.")
    notes = [f"SOUL.md condensed from {len(soul):,} to {min(len(text), PROFILE_PROMPT_MAX):,} characters for AGENTS.md."]
    if len(text) > PROFILE_PROMPT_MAX:
        text = _cut(text, PROFILE_PROMPT_MAX)
        notes.append("The condensed AGENTS.md was still too long and was cut to 4,000 characters.")
    return text, notes


def memory_text(profile: Profile) -> str:
    """memories/MEMORY.md entries as Botkins memory: one "- fact" line each."""
    lines = ["- " + " ".join(e.split())[:ENTRY_MAX] for e in _entries(_read(profile.home / "memories" / "MEMORY.md"))]
    text = "\n".join(lines)
    if len(text) > MEMORY_MAX:
        raise ValueError(f"Profile '{profile.name}' has {len(text):,} characters of memory; "
                         f"Botkins keeps up to {MEMORY_MAX:,}. Trim it in Hermes first.")
    return text


def _profile_doc(profile: Profile, file: str) -> str:
    """USER.md and IDENTITY.md as they are; Hermes' § entry separators become list items."""
    text = _profile_text(profile, file)
    entries = _entries(text)
    if "§" in text:
        text = "\n".join("- " + " ".join(e.split()) for e in entries)
    return text


def build_clone(profile: Profile, *, full: bool, complete: Complete | None = None,
                name: str | None = None, description: str | None = None) -> Clone:
    clone = Clone(build_agent(profile, name=name, description=description))
    if clone.agent.truncated:
        clone.notes.append("Instructions were cut to Botkins' 30,000-character limit.")
    if not full:
        return clone
    agents_md, notes = condense(_soul(profile), complete)
    clone.files["AGENTS.md"] = agents_md
    clone.notes += notes
    for file in ("USER.md", "IDENTITY.md"):
        text = _profile_doc(profile, file)
        if not text:
            clone.notes.append(f"No {file} in profile '{profile.name}'; the bot starts without one.")
            continue
        if len(text.encode()) > PROFILE_BYTES_MAX:
            raise ValueError(f"{file} is over Botkins' 64 KiB limit for a profile file. Trim it in Hermes first.")
        if len(text) > PROFILE_PROMPT_MAX:
            clone.notes.append(f"{file} has {len(text):,} characters; each turn sees the first 4,000 "
                               "and the bot reads the rest with profile_read.")
        clone.files[file] = text
    memory = memory_text(profile)
    if memory:
        clone.files["MEMORY.md"] = memory
    else:
        clone.notes.append(f"No memories in profile '{profile.name}'.")
    return clone


# Writing -----------------------------------------------------------------------------------

def _write(path: Path, text: str, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text.rstrip("\n") + "\n", encoding="utf-8")
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return path


def copilot_agents_dir() -> Path:
    home = Path(os.environ.get("COPILOT_HOME") or Path.home() / ".copilot").expanduser()
    # Botkins points COPILOT_HOME at its own private state for the sessions it runs; the app itself
    # reads the person's Copilot home, so a COPILOT_HOME inside Botkins' data is not the one it reads.
    data = botkins_data_dir()
    if data is not None:
        try:
            home.resolve().relative_to(data.resolve())
            home = Path.home() / ".copilot"
        except ValueError:
            pass
    return home / "agents"


def staging_dir(agent_path: Path) -> Path:
    """Where a full clone's files wait until the bot exists. Botkins lists only .md files in the agents folder."""
    return agent_path.with_name(agent_path.name.replace(".agent.md", ".clone"))


def write_agent(agent: Agent, out_dir: Path | None = None, *, force: bool = False) -> Path:
    out_dir = out_dir or copilot_agents_dir()
    path = out_dir / agent.filename
    # Running the same clone again (for example to load the files after importing) is fine.
    if path.exists() and not force and _read(path) == render(agent).strip():
        return path
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists. Use --force to replace it.")
    return _write(path, render(agent), 0o644)


def stage_files(clone: Clone, agent_path: Path) -> Path:
    folder = staging_dir(agent_path)
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    for stale in folder.glob("*.md"):
        if stale.name not in clone.files:
            stale.unlink()
    for file, text in clone.files.items():
        _write(folder / file, text)
    return folder


def export_bundle(clone: Clone, out_dir: Path) -> Path:
    """A light clone is its agent file; a full clone is a zip of the agent file, profile files and memory."""
    out_dir.mkdir(parents=True, exist_ok=True)
    agent_file = clone.agent.filename
    if not clone.full:
        return _write(out_dir / agent_file, render(clone.agent))
    path = out_dir / (FILE_PREFIX + clone.agent.slug + ".botkins-clone.zip")
    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(agent_file, render(clone.agent))
        for file, text in clone.files.items():
            bundle.writestr(file, text.rstrip("\n") + "\n")
        bundle.writestr("README.txt", _bundle_readme(clone))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


def _bundle_readme(clone: Clone) -> str:
    name = clone.agent.name
    lines = [
        f"{name}, cloned from the Hermes profile '{clone.agent.profile}'.",
        "",
        f"1. Put {clone.agent.filename} in ~/.copilot/agents, then in Botkins open",
        f"   Create a bot > Import agents and choose {name}.",
        f"2. Give the bot its files from this folder (or ask {name} to save them with profile_write",
        "   and memory_save):",
    ]
    targets = {"AGENTS.md": "the bot's AGENTS.md", "USER.md": "the bot's USER.md",
               "IDENTITY.md": "the bot's IDENTITY.md", "MEMORY.md": "the bot's Memory"}
    lines += [f"   - {file} -> {targets[file]}" for file in clone.files]
    lines += ["", "Or skip the copying: on the machine that runs Botkins, run",
              f"hermes botkins-clone full {clone.agent.profile}", ""]
    return "\n".join(lines)


# Loading into Botkins ----------------------------------------------------------------------

def botkins_data_dir() -> Path | None:
    """The Botkins data folder (the one holding workspace.json), or None when none is found."""
    if os.environ.get("BOTKINS_DATA"):
        return Path(os.environ["BOTKINS_DATA"]).expanduser()
    home = Path.home()
    candidates = []
    if os.environ.get("BOTKINS_DATA_DIR"):
        candidates.append(Path(os.environ["BOTKINS_DATA_DIR"]).expanduser() / "data")
    config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    share = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
    candidates += [home / "Library" / "Application Support" / "Botkins" / "data",
                   config / "Botkins" / "data", share / "botkins" / "data"]
    return next((c for c in candidates if (c / "workspace.json").is_file()), None)


def find_bot(agent_path: Path, data_dir: Path | None = None) -> dict | None:
    """The Botkins bot made from this agent file, read from workspace.json (never written)."""
    data_dir = data_dir or botkins_data_dir()
    if data_dir is None:
        return None
    try:
        state = json.loads((data_dir / "workspace.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    for bot in state.get("bots", []):
        origin = bot.get("origin") or {}
        if origin.get("file") and Path(origin["file"]).resolve() == agent_path.resolve():
            return bot
    return None


def _target(data_dir: Path, bot_id: str, file: str) -> Path:
    if file == "MEMORY.md":
        return data_dir / "memory" / bot_id / "MEMORY.md"
    return data_dir / "files" / bot_id / file


def push_files(agent_path: Path, data_dir: Path | None = None, *, force: bool = False) -> tuple[str, list[str]]:
    """Puts a full clone's waiting files into the bot Botkins made from it.

    Returns the bot's name and the files written. Raises LookupError until the bot exists, and
    FileExistsError rather than replace a file the bot already has (unless ``force``).
    """
    folder = staging_dir(agent_path)
    staged = {f: (folder / f).read_text("utf-8").strip() for f in (*PROFILE_FILES, "MEMORY.md") if (folder / f).is_file()}
    if not staged:
        raise ValueError("Nothing is waiting for this bot. Run a full clone first.")
    data_dir = data_dir or botkins_data_dir()
    bot = find_bot(agent_path, data_dir) if data_dir else None
    if bot is None:
        raise LookupError("not imported")
    bot_id = str(bot.get("id", ""))
    if not _BOT_ID.match(bot_id):
        raise ValueError("Botkins gave that bot an id this plugin doesn't recognise.")
    name = bot.get("name") or bot_id
    targets = {f: _target(data_dir, bot_id, f) for f in staged}
    if not force:
        taken = [f for f, t in targets.items() if (current := _read(t)) and current != staged[f]]
        if taken:
            raise FileExistsError(f"{name} already has {', '.join(taken)} in Botkins. Use --force to replace it.")
    written = []
    for file, target in targets.items():
        if _read(target) == staged[file]:
            continue
        for folder_path in (target.parent.parent, target.parent):
            folder_path.mkdir(mode=0o700, exist_ok=True)
        _write(target, staged[file])
        written.append(file)
    return name, written


# Reports -----------------------------------------------------------------------------------

def summary(clone: Clone, path: Path) -> str:
    agent = clone.agent
    lines = [
        f"✅ {agent.name} is cloned for Botkins ({'full' if clone.full else 'light'}).",
        f"   File: {path}",
        f"   Role: {agent.description}",
        f"   Model: {agent.model or 'Botkins default'}",
    ]
    if clone.full:
        lines.append("   Brings: " + ", ".join(clone.files))
    lines += [f"   ⚠️ {note}" for note in clone.notes]
    return "\n".join(lines)


def files_status(clone: Clone, path: Path, *, force: bool = False, data_dir: Path | None = None) -> str:
    try:
        bot, written = push_files(path, data_dir, force=force)
    except LookupError:
        return (f"Next: in Botkins, open Create a bot → Import agents and choose {clone.agent.name}. "
                f"Then run this again (hermes botkins-clone full {clone.agent.profile}) to give it "
                f"{', '.join(clone.files)}.")
    if not written:
        return f"🧠 {bot} already has these files in Botkins."
    return f"🧠 Loaded {', '.join(written)} into {bot} in Botkins. New chats with {bot} use them."


def scratch_dir() -> Path:
    try:
        from hermes_constants import get_scratch_dir

        base = Path(get_scratch_dir())
    except Exception:
        import tempfile

        base = Path(tempfile.gettempdir())
    return base / f"botkins-clone-{time.strftime('%Y%m%d-%H%M%S')}"
