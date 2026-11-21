"""Run from the plugin folder: python3 -m pytest tests

Set BOTKINS_AGENTS_MJS to Botkins' desktop/desktop/providers/copilot/agents.mjs to also check the
agent file with the reader Botkins itself uses.
"""

import json
import os
import subprocess
import zipfile
from pathlib import Path

import pytest

import botkins_clone_plugin as plugin
from botkins_clone_plugin import clone

SOUL = '# Ralph\n\nYou are Ralph, a pragmatic agentic engineer with strong "taste". You value clarity.\n\n## Voice\n\n- Be direct.\n'


@pytest.fixture
def root(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "ralph" / "memories").mkdir(parents=True)
    (root / "config.yaml").write_text("model:\n  default: gpt-6\n")
    (root / "SOUL.md").write_text("You are Max, the main agent.")
    ralph = root / "profiles" / "ralph"
    (ralph / "SOUL.md").write_text(SOUL)
    (ralph / "IDENTITY.md").write_text("# Ralph\n\nEngineer. Dry.")
    (ralph / "config.yaml").write_text("model:\n  default: claude-opus-5-5[1m]\n  provider: x\n")
    (ralph / "memories" / "MEMORY.md").write_text("Fact one.\n§\nFact two.")
    (ralph / "memories" / "USER.md").write_text("Person likes\nshort answers.\n§\nPrefers tea.")
    (root / "profiles" / "manager" / "runtime").mkdir(parents=True)  # no identity: not a profile
    (root / "profiles" / "gone").mkdir()
    (root / "profiles" / "gone" / "SOUL.md").write_text("You are Gone.")
    (root / "profiles" / ".deleted" / "gone").mkdir(parents=True)
    return root


def ralph(root):
    return clone.find_profile("ralph", root)


def test_lists_only_real_profiles(root):
    assert [p.name for p in clone.list_profiles(root)] == ["default", "ralph"]


def test_light_clone_is_soul_only(root):
    result = clone.build_clone(ralph(root), full=False)
    assert result.agent.name == "Ralph"
    assert result.agent.description.startswith("A pragmatic agentic engineer")
    assert result.agent.model == "claude-opus-5.5"
    assert result.files == {}


def test_full_clone_maps_each_file(root):
    result = clone.build_clone(ralph(root), full=True)
    assert result.files["AGENTS.md"] == SOUL.strip()  # fits 4,000, so no model call
    assert result.files["USER.md"] == "- Person likes short answers.\n- Prefers tea."
    assert result.files["IDENTITY.md"] == "# Ralph\n\nEngineer. Dry."
    assert result.files["MEMORY.md"] == "- Fact one.\n- Fact two."
    assert result.agent.instructions == SOUL.strip()


def test_full_clone_condenses_long_soul_with_the_model(root):
    long_soul = "You are Ralph, an engineer.\n" + "Keep this rule.\n" * 400
    (root / "profiles" / "ralph" / "SOUL.md").write_text(long_soul)
    calls = []

    def complete(messages):
        calls.append(messages)
        return "```markdown\nYou are Ralph. Short now.\n```" if len(calls) > 1 else "x" * 5000

    result = clone.build_clone(ralph(root), full=True, complete=complete)
    assert len(calls) == 2  # first answer too long, so it asks once more
    assert result.files["AGENTS.md"] == "You are Ralph. Short now."
    assert result.agent.instructions == long_soul.strip()  # instructions keep the whole SOUL
    assert any("condensed" in n for n in result.notes)


def test_condense_hard_cuts_when_model_overshoots_twice(root):
    text, notes = clone.condense("line\n" * 2000, lambda m: "word line\n" * 1000)
    assert len(text) <= clone.PROFILE_PROMPT_MAX
    assert any("cut" in n for n in notes)


def test_long_soul_without_a_model_is_refused(root):
    (root / "profiles" / "ralph" / "SOUL.md").write_text("You are Ralph.\n" + "x\n" * 3000)
    with pytest.raises(ValueError, match="needs condensing"):
        clone.build_clone(ralph(root), full=True)


def test_missing_identity_is_noted_not_fatal(root):
    (root / "profiles" / "ralph" / "IDENTITY.md").unlink()
    result = clone.build_clone(ralph(root), full=True)
    assert "IDENTITY.md" not in result.files
    assert any("No IDENTITY.md" in n for n in result.notes)


def test_memory_over_botkins_limit_is_refused(root):
    (root / "profiles" / "ralph" / "memories" / "MEMORY.md").write_text("\n§\n".join(["x" * 500] * 60))
    with pytest.raises(ValueError, match="Botkins keeps up to"):
        clone.build_clone(ralph(root), full=True)


def _workspace(data, agent_path, bot_id="bot-1"):
    data.mkdir(parents=True, exist_ok=True)
    (data / "workspace.json").write_text(json.dumps(
        {"bots": [{"id": bot_id, "name": "Ralph", "origin": {"provider": "copilot", "file": str(agent_path)}}]}))


def test_full_clone_waits_then_fills_the_bot(root, tmp_path):
    result = clone.build_clone(ralph(root), full=True)
    path = clone.write_agent(result.agent, tmp_path / "agents")
    clone.stage_files(result, path)
    assert sorted(p.name for p in (tmp_path / "agents").glob("*.md")) == ["hermes-ralph.agent.md"]
    data = tmp_path / "botkins"
    assert "Create a bot → Import agents" in clone.files_status(result, path, data_dir=data)
    _workspace(data, path)
    assert "Loaded AGENTS.md, USER.md, IDENTITY.md, MEMORY.md into Ralph" in clone.files_status(result, path, data_dir=data)
    assert (data / "files" / "bot-1" / "AGENTS.md").read_text() == SOUL.strip() + "\n"
    assert (data / "files" / "bot-1" / "IDENTITY.md").exists()
    memory = data / "memory" / "bot-1" / "MEMORY.md"
    assert memory.read_text() == "- Fact one.\n- Fact two.\n"
    assert oct(memory.stat().st_mode & 0o777) == "0o600"
    assert "already has these files" in clone.files_status(result, path, data_dir=data)


def test_full_clone_does_not_replace_what_the_bot_has(root, tmp_path):
    result = clone.build_clone(ralph(root), full=True)
    path = clone.write_agent(result.agent, tmp_path / "agents")
    clone.stage_files(result, path)
    data = tmp_path / "botkins"
    _workspace(data, path)
    (data / "files" / "bot-1").mkdir(parents=True)
    (data / "files" / "bot-1" / "USER.md").write_text("Learned in Botkins.\n")
    with pytest.raises(FileExistsError, match="USER.md"):
        clone.push_files(path, data)
    assert not (data / "memory" / "bot-1" / "MEMORY.md").exists()  # nothing written on refusal
    clone.push_files(path, data, force=True)
    assert "Prefers tea" in (data / "files" / "bot-1" / "USER.md").read_text()


def test_write_refuses_overwrite_without_force(root, tmp_path):
    agent = clone.build_agent(ralph(root))
    out = tmp_path / "agents"
    path = clone.write_agent(agent, out)
    assert path.name == "hermes-ralph.agent.md"
    clone.write_agent(agent, out)  # the same clone again is fine
    agent.instructions += "\nChanged."
    with pytest.raises(FileExistsError):
        clone.write_agent(agent, out)
    clone.write_agent(agent, out, force=True)


def test_export_light_is_the_agent_file(root, tmp_path):
    path = clone.export_bundle(clone.build_clone(ralph(root), full=False), tmp_path / "out")
    assert path.parent == tmp_path / "out" and path.name == "hermes-ralph.agent.md"
    assert path.read_text().startswith('---\nname: "Ralph"')


def test_export_full_is_a_zip_of_every_file(root, tmp_path):
    path = clone.export_bundle(clone.build_clone(ralph(root), full=True), tmp_path / "out")
    assert path.name == "hermes-ralph.botkins-clone.zip"
    with zipfile.ZipFile(path) as bundle:
        names = set(bundle.namelist())
        assert names == {"hermes-ralph.agent.md", "AGENTS.md", "USER.md", "IDENTITY.md", "MEMORY.md", "README.txt"}
        assert "Fact two." in bundle.read("MEMORY.md").decode()


def test_ignores_botkins_private_copilot_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("BOTKINS_DATA", str(tmp_path / "botkins"))
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / "botkins" / "copilot"))
    assert clone.copilot_agents_dir() == tmp_path / ".copilot" / "agents"
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / "elsewhere"))
    assert clone.copilot_agents_dir() == tmp_path / "elsewhere" / "agents"


def test_finds_botkins_data_on_linux(tmp_path, monkeypatch):
    for var in ("BOTKINS_DATA", "BOTKINS_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert clone.botkins_data_dir() is None
    data = tmp_path / ".local" / "share" / "botkins" / "data"
    data.mkdir(parents=True)
    (data / "workspace.json").write_text("{}")
    assert clone.botkins_data_dir() == data


class FakeLlm:
    def complete(self, messages, **kw):
        raise AssertionError("a short SOUL needs no model call")


class FakeCtx:
    def __init__(self, answers):
        self.answers, self.commands, self.cli, self.llm = list(answers), {}, {}, FakeLlm()

    def ask_choice(self, question, choices):
        return self.answers.pop(0) if self.answers else None

    def register_command(self, name, handler, **kw):
        self.commands[name] = handler

    def register_cli_command(self, name, **kw):
        self.cli[name] = kw


@pytest.fixture
def ctx(root, tmp_path, monkeypatch):
    def make(answers=()):
        monkeypatch.setattr(clone, "hermes_root", lambda: root)
        monkeypatch.setattr(clone, "scratch_dir", lambda: tmp_path / "scratch")
        monkeypatch.setenv("COPILOT_HOME", str(tmp_path / "copilot"))
        monkeypatch.setenv("BOTKINS_DATA", str(tmp_path / "botkins"))
        c = FakeCtx(answers)
        plugin.register(c)
        return c
    return make


def test_slash_command_asks_profile_and_mode(ctx, tmp_path):
    c = ctx(["ralph", "full"])
    assert "botkins-clone" in c.cli
    reply = c.commands["botkins-clone"]("")
    assert "Ralph is cloned for Botkins (full)" in reply and "Create a bot → Import agents" in reply
    agent = tmp_path / "copilot" / "agents" / "hermes-ralph.agent.md"
    assert "Fact two." not in agent.read_text()
    _workspace(tmp_path / "botkins", agent)
    assert "Loaded" in c.commands["botkins-clone"]("full ralph")


def test_slash_export_attaches_the_bundle(ctx, tmp_path):
    reply = ctx().commands["botkins-clone"]("export full ralph")
    media = [l for l in reply.splitlines() if l.startswith("MEDIA:")]
    assert media == [f"MEDIA:{tmp_path / 'scratch' / 'hermes-ralph.botkins-clone.zip'}"]
    assert not (tmp_path / "copilot" / "agents").exists()  # export never installs


def test_slash_rejects_unknown_flags(ctx):
    assert ctx().commands["botkins-clone"]("light ralph --memory").startswith("Usage")


def test_cli_subcommands(ctx, tmp_path, capsys):
    import argparse

    ctx()
    parser = argparse.ArgumentParser()
    plugin._setup_parser(parser)
    args = parser.parse_args(["export", "full", "ralph", "--out", str(tmp_path / "dl")])
    assert args.func(args) == 0
    assert (tmp_path / "dl" / "hermes-ralph.botkins-clone.zip").exists()
    assert "File: " in capsys.readouterr().out
    args = parser.parse_args(["light", "ralph"])
    assert args.func(args) == 0
    assert (tmp_path / "copilot" / "agents" / "hermes-ralph.agent.md").exists()


@pytest.mark.skipif(not os.environ.get("BOTKINS_AGENTS_MJS"), reason="BOTKINS_AGENTS_MJS not set")
def test_botkins_reads_the_file(root, tmp_path):
    result = clone.build_clone(ralph(root), full=True)
    out = tmp_path / "agents"
    clone.stage_files(result, clone.write_agent(result.agent, out))
    script = (
        f"import({json.dumps(Path(os.environ['BOTKINS_AGENTS_MJS']).as_uri())})"
        f".then(m => console.log(JSON.stringify(m.readAgents({json.dumps(str(out))}))))"
    )
    found = json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert len(found) == 1  # the staged .clone folder is not listed as an agent
    got = found[0]
    assert got["title"] == "Ralph"
    assert got["description"] == result.agent.description
    assert got["model"] == "claude-opus-5.5"
    assert got["instructions"] == result.agent.instructions
    assert got["ownTools"] is False
