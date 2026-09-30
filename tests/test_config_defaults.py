"""Settings' defaults (config.load_settings): run from the repo they are the owner's own
folders; in the app people download, none of them: projects in ~/Developer and no BSH
research desk. The environment still says otherwise when it names them."""

from pathlib import Path

import pytest

from jarvis import config, packaged


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    for name in ("JARVIS_BSH_DIR", "JARVIS_PROJECTS_DIR"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path / "no.env"  # an .env that isn't there


def test_from_the_repo_the_owners_folders_are_the_defaults(monkeypatch, clean_env):
    monkeypatch.setattr(packaged, "is_packaged", lambda prefix=None: False)
    settings = config.load_settings(clean_env)
    assert settings.projects_dir == config.DEFAULT_PROJECTS_DIR
    assert settings.bsh_dir == config.DEFAULT_BSH_DIR


def test_the_downloadable_app_assumes_none_of_the_owners_folders(monkeypatch, clean_env):
    monkeypatch.setattr(packaged, "is_packaged", lambda prefix=None: True)
    settings = config.load_settings(clean_env)
    assert settings.projects_dir == Path.home() / "Developer"
    assert settings.bsh_dir is None  # the research desk's tools and sources stay off
    assert "Investment agent" not in str(settings.projects_dir)


def test_the_environment_still_names_them(monkeypatch, clean_env, tmp_path):
    monkeypatch.setattr(packaged, "is_packaged", lambda prefix=None: True)
    monkeypatch.setenv("JARVIS_PROJECTS_DIR", str(tmp_path / "code"))
    monkeypatch.setenv("JARVIS_BSH_DIR", str(tmp_path / "desk"))
    settings = config.load_settings(clean_env)
    assert settings.projects_dir == tmp_path / "code" and settings.bsh_dir == tmp_path / "desk"
