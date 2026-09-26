from pathlib import Path

import pytest

from transcriber import models


def fake_download(files=("model.bin", "config.json")):
    calls = []

    def snapshot_download(repo, local_dir, allow_patterns, tqdm_class=None):
        calls.append(repo)
        local_dir = Path(local_dir)
        (local_dir / ".cache" / "huggingface").mkdir(parents=True)
        for name in files:
            (local_dir / name).write_text("x")
    return snapshot_download, calls


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(models, "_expected_size", lambda repo: None)


def patch_hub(monkeypatch, fn):
    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", fn)


def test_repo_for_known_sizes_only():
    assert models.repo_for(Path("m/faster-whisper-large-v3-turbo")) == \
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    assert models.repo_for(Path("m/faster-whisper-small")) == "Systran/faster-whisper-small"
    assert models.repo_for(Path("m/my-model")) is None


def test_download_is_atomic_and_idempotent(tmp_path, monkeypatch, offline):
    fn, calls = fake_download()
    patch_hub(monkeypatch, fn)
    target = tmp_path / "faster-whisper-small"
    target.mkdir()  # an empty directory, e.g. created by Docker, is fine

    models.download(target)
    assert models.is_complete(target)
    assert not (target / ".cache").exists()
    assert not (tmp_path / ".faster-whisper-small.partial").exists()
    assert calls == ["Systran/faster-whisper-small"]

    monkeypatch.setattr("sys.argv", ["download-model", str(target)])
    models.main()  # already there: no second download
    assert len(calls) == 1


def test_incomplete_download_is_not_renamed(tmp_path, monkeypatch, offline):
    fn, _ = fake_download(files=("config.json",))
    patch_hub(monkeypatch, fn)
    target = tmp_path / "faster-whisper-small"
    with pytest.raises(SystemExit):
        models.download(target)
    assert not target.exists()


def test_never_overwrites_foreign_files(tmp_path, monkeypatch, offline):
    fn, calls = fake_download()
    patch_hub(monkeypatch, fn)
    target = tmp_path / "faster-whisper-small"
    target.mkdir()
    (target / "notes.txt").write_text("mine")
    with pytest.raises(SystemExit):
        models.download(target)
    assert calls == [] and (target / "notes.txt").read_text() == "mine"


def test_unknown_model_directory(tmp_path):
    with pytest.raises(SystemExit):
        models.download(tmp_path / "my-model")


def test_whisper_model_env(monkeypatch, tmp_path):
    from transcriber import cli

    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    assert cli.default_model() == str(cli.MODELS_DIR / "faster-whisper-large-v3-turbo")
    monkeypatch.setenv("WHISPER_MODEL", "faster-whisper-small")
    assert cli.default_model() == str(cli.MODELS_DIR / "faster-whisper-small")
    monkeypatch.setenv("WHISPER_MODEL", str(tmp_path / "m"))
    assert cli.default_model() == str(tmp_path / "m")
