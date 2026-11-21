"""Botkins Clone: clone a Hermes profile as a Botkins bot.

* ``hermes botkins-clone light <profile>`` writes the SOUL as a Botkins agent file.
* ``hermes botkins-clone full <profile>`` also brings USER.md, IDENTITY.md and MEMORY.md, and the
  SOUL condensed into the bot's AGENTS.md.
* ``hermes botkins-clone export [light|full] <profile>`` makes the same files for download instead.
* ``/botkins-clone`` does the same from a chat; export attaches the files to the reply.

The work lives in ``clone.py``.
"""

from __future__ import annotations

import shlex
import sys
from pathlib import Path

from . import clone

MODES = ("light", "full")
USAGE = ("Usage: /botkins-clone [light|full] [profile] [--force]   ·   "
         "/botkins-clone export [light|full] [profile]   ·   /botkins-clone list")

_ctx = None


def _complete(messages: list) -> str:
    """The condensing call, on the person's active Hermes model."""
    if _ctx is None:
        raise ValueError("No model is available outside Hermes.")
    return _ctx.llm.complete(messages, purpose="condense SOUL.md into a Botkins AGENTS.md").text


def _build(profile_name: str, mode: str, name: str | None = None, description: str | None = None) -> clone.Clone:
    profile = clone.find_profile(profile_name)
    return clone.build_clone(profile, full=mode == "full", complete=_complete if _ctx else None,
                             name=name, description=description)


def _clone(profile_name: str, mode: str, *, force: bool, out: Path | None = None, name: str | None = None,
           description: str | None = None, dry_run: bool = False) -> str:
    result = _build(profile_name, mode, name, description)
    if dry_run:
        parts = [clone.render(result.agent)]
        parts += [f"--- {file} ---\n{text}" for file, text in result.files.items()]
        return "\n".join(parts)
    path = clone.write_agent(result.agent, out, force=force)
    report = clone.summary(result, path)
    if result.full:
        clone.stage_files(result, path)
        report += "\n" + clone.files_status(result, path, force=force)
    else:
        report += f"\nNext: in Botkins, open Create a bot → Import agents and choose {result.agent.name}."
    return report


def _export(profile_name: str, mode: str, *, out: Path | None = None, name: str | None = None,
            description: str | None = None) -> tuple[clone.Clone, Path]:
    result = _build(profile_name, mode, name, description)
    return result, clone.export_bundle(result, out or clone.scratch_dir())


def _export_reply(result: clone.Clone, path: Path) -> str:
    what = "agent file" if not result.full else "agent file, " + ", ".join(result.files) + " and a README"
    lines = [f"📦 {result.agent.name} is cloned for download ({'full' if result.full else 'light'}): {what}."]
    lines += [f"   ⚠️ {note}" for note in result.notes]
    lines += ["", f"MEDIA:{path}"]
    return "\n".join(lines)


def _listing() -> str:
    profiles = clone.list_profiles()
    if not profiles:
        return "No Hermes profiles found."
    return "Hermes profiles:\n" + "\n".join(f"  • {p.name}" for p in profiles)


# Slash command ---------------------------------------------------------------------------

def _make_slash(ctx):
    def handle(raw_args: str) -> str:
        try:
            args = shlex.split(raw_args or "")
        except ValueError:
            return USAGE
        flags = {a for a in args if a.startswith("--")}
        words = [a for a in args if not a.startswith("--")]
        if words == ["list"]:
            return _listing()
        export = bool(words) and words[0] == "export"
        words = words[1:] if export else words
        mode = words.pop(0) if words and words[0] in MODES else None
        if flags - {"--force"} or len(words) > 1 or (export and flags):
            return USAGE
        profile = words[0] if words else None
        if profile is None:
            choices = [p.name for p in clone.list_profiles()]
            if not choices:
                return "No Hermes profiles found."
            profile = ctx.ask_choice("Which Hermes profile should be cloned to Botkins?", choices)
            if profile is None:
                return _listing() + "\n\n" + USAGE
        if mode is None:
            mode = ctx.ask_choice(
                "Light or full clone?",
                [{"value": "light", "label": "Light", "description": "SOUL.md only, as the bot's instructions"},
                 {"value": "full", "label": "Full",
                  "description": "SOUL, USER, IDENTITY and MEMORY, with the SOUL condensed into AGENTS.md"}],
            ) or "light"
        try:
            if export:
                return _export_reply(*_export(profile, mode))
            return _clone(profile, mode, force="--force" in flags)
        except (ValueError, FileExistsError, OSError) as exc:
            return f"Couldn't clone: {exc}"
        except Exception as exc:  # the condensing model call
            return f"Couldn't clone: the model call failed ({exc})."

    return handle


# CLI ---------------------------------------------------------------------------------------

def _add_common(parser, *, export: bool) -> None:
    parser.add_argument("profile", nargs="?", help="Profile to clone. Omit to choose.")
    parser.add_argument("--name", help="Bot name in Botkins (default: the name in SOUL.md)")
    parser.add_argument("--description", help="What the bot does; Botkins makes its role from this")
    if export:
        parser.add_argument("--out", type=Path, help="Folder for the download (default: a Hermes scratch folder)")
        return
    parser.add_argument("--force", action="store_true", help="Replace an earlier clone or files the bot already has")
    parser.add_argument("--out", type=Path, help="Folder to write the agent file to (default: ~/.copilot/agents)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be cloned instead of writing it")


def _setup_parser(parser) -> None:
    sub = parser.add_subparsers(dest="command", metavar="{light,full,export,list}")
    light = sub.add_parser("light", help="Clone SOUL.md as the bot's instructions")
    _add_common(light, export=False)
    full = sub.add_parser("full", help="Clone SOUL, USER, IDENTITY and MEMORY (SOUL condensed into AGENTS.md)")
    _add_common(full, export=False)
    export = sub.add_parser("export", help="Make the clone's files for download instead of installing them")
    export.add_argument("mode", nargs="?", choices=MODES, default="light", help="light (default) or full")
    _add_common(export, export=True)
    sub.add_parser("list", help="List the Hermes profiles")
    parser.set_defaults(func=_handle_cli)


def _prompt_profile() -> str | None:
    profiles = clone.list_profiles()
    if not profiles:
        print("No Hermes profiles found.", file=sys.stderr)
        return None
    if not sys.stdin.isatty():
        print(_listing() + "\n\nName one: hermes botkins-clone light <profile>", file=sys.stderr)
        return None
    for i, p in enumerate(profiles, 1):
        print(f"  {i}. {p.name}")
    answer = input("Profile to clone (number or name): ").strip()
    if answer.isdigit() and 1 <= int(answer) <= len(profiles):
        return profiles[int(answer) - 1].name
    return answer or None


def _handle_cli(args) -> int:
    command = getattr(args, "command", None)
    if command == "list":
        print(_listing())
        return 0
    if command is None:
        print("Choose one: hermes botkins-clone {light,full,export,list} [profile]", file=sys.stderr)
        return 1
    profile = args.profile or _prompt_profile()
    if not profile:
        return 1
    try:
        if command == "export":
            result, path = _export(profile, args.mode, out=args.out, name=args.name, description=args.description)
            print(_export_reply(result, path).replace("MEDIA:", "File: "))
        else:
            print(_clone(profile, command, force=args.force, out=args.out, name=args.name,
                         description=args.description, dry_run=args.dry_run))
        return 0
    except (ValueError, FileExistsError, OSError) as exc:
        print(f"Couldn't clone: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # the condensing model call
        print(f"Couldn't clone: the model call failed ({exc}).", file=sys.stderr)
        return 1


def register(ctx) -> None:
    global _ctx
    _ctx = ctx
    ctx.register_command(
        "botkins-clone",
        handler=_make_slash(ctx),
        description="Clone a Hermes profile as a Botkins bot (light, full or export)",
        args_hint="[export] [light|full] [profile]",
    )
    ctx.register_cli_command(
        name="botkins-clone",
        help="Clone a Hermes profile as a Botkins bot",
        setup_fn=_setup_parser,
        handler_fn=_handle_cli,
        description="Clone a Hermes profile as a Botkins bot: light (SOUL only) or full (SOUL, USER, "
                    "IDENTITY, MEMORY), installed for Botkins on this machine or exported for download.",
    )
