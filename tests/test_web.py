import json
import time
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from transcriber.server import create_app
from transcriber.server.db import Setting
from transcriber.summary import Usage

from test_summary_types import make_data

ADMIN = ("admin@example.com", "admin-pass-1")
USER = ("anna@example.com", "anna-pass-1")

SUMMARY = {
    "meeting_type": "meeting", "title": "Планёрка", "tldr": "Обсудили релиз.",
    "participants": [], "key_figures": [], "topics": [], "decisions": [],
    "action_items": [], "open_questions": [],
    "details": {"status_updates": [], "blockers": [], "risks": []},
}


class FakePipeline:
    def __init__(self, summary_error: Exception | None = None, phrases=None):
        self.summary_error = summary_error
        self.phrases = [(0.0, "привет"), (1.5, "как дела")] if phrases is None else phrases
        self.summarized_with = []  # (provider, summary_type)
        self.languages = []
        self.configs = []

    def duration(self, path):
        return None if path.endswith(".txt") else 2.0

    def transcribe(self, path, language):
        self.languages.append(language)
        for i, phrase in enumerate(self.phrases):
            yield phrase
            yield float(i + 1)

    def resolve_provider(self, transcript, provider, config, registry):
        return "ollama" if provider == "auto" else provider

    def summarize(self, transcript, provider, summary_type, *, config, registry, on_usage):
        self.summarized_with.append((provider, summary_type))
        self.configs.append(config)
        on_usage(Usage(provider, "fake-model", "summary", 1000, 200))
        if self.summary_error:
            raise self.summary_error
        type_id = "meeting" if summary_type == "auto" else summary_type
        t = registry.get(type_id)
        if t.builtin:
            return registry.parse(make_data(type_id, title="Планёрка"))
        details = {k: ["пункт"] for k in t.details.model_fields}
        return registry.parse({**SUMMARY, "meeting_type": type_id, "details": details})

    def provider_status(self, config):
        self.configs.append(config)
        return {"deepseek": {"available": False, "reason": "no_api_key", "model": "x"},
                "ollama": {"available": True, "reason": None, "model": "y"}}


@pytest.fixture
def make_app(tmp_path):
    def make(pipeline=None, env=None):
        return create_app(jobs_dir=tmp_path / "jobs", pipeline=pipeline or FakePipeline(),
                          web_dist=tmp_path / "dist", database=f"sqlite:///{tmp_path / 'db.sqlite'}",
                          secret_key="test-secret",
                          env={"ADMIN_EMAIL": ADMIN[0], "ADMIN_PASSWORD": ADMIN[1], **(env or {})})
    return make


def sign_in(client, email, password):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def make_client(make_app):
    def make(pipeline=None, login=ADMIN, env=None):
        client = TestClient(make_app(pipeline, env))
        if login:
            sign_in(client, *login)
        return client
    return make


def add_user(admin_client, email=USER[0], password=USER[1], role="user"):
    resp = admin_client.post("/api/admin/users", json={"email": email, "name": "Анна",
                                                        "password": password, "role": role})
    assert resp.status_code == 201, resp.text
    return resp.json()


def as_user(client, credentials=USER):
    """A second client on the same app, signed in as someone else."""
    other = TestClient(client.app)
    sign_in(other, *credentials)
    return other


def upload(client, name="call.wav", **form):
    data = {"provider": "auto", "summary": "true", **form}
    resp = client.post("/api/jobs", files={"file": (name, b"RIFF....", "audio/wav")}, data=data)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def wait_until(client, job_id, predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if predicate(job):
            return job
        time.sleep(0.02)
    raise AssertionError(f"timeout, last state: {job}")


# --- health ---

def test_health_needs_no_sign_in_and_checks_database(make_client):
    client = make_client(login=None)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "database": True}

    def broken():
        raise RuntimeError("database is down")

    client.app.state.sessions = broken
    resp = client.get("/api/health")
    assert resp.status_code == 503
    assert resp.json()["database"] is False


# --- auth ---

def test_api_requires_sign_in(make_client):
    client = make_client(login=None)
    for path in ("/api/auth/me", "/api/config", "/api/jobs", "/api/admin/users"):
        resp = client.get(path)
        assert resp.status_code == 401, path
        assert resp.json()["detail"] == "Нужно войти"


def test_sign_in_and_out(make_client):
    client = make_client(login=None)
    assert client.post("/api/auth/login",
                       json={"email": ADMIN[0], "password": "wrong"}).status_code == 401
    me = sign_in(client, " Admin@Example.com ", ADMIN[1])  # email is case-insensitive
    assert me == {"id": me["id"], "email": ADMIN[0], "name": "admin", "role": "admin"}
    assert client.get("/api/auth/me").json()["email"] == ADMIN[0]
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_login_throttled_after_repeated_failures(make_client):
    client = make_client(login=None)
    for _ in range(5):
        client.post("/api/auth/login", json={"email": "x@example.com", "password": "nope"})
    resp = client.post("/api/auth/login", json={"email": "x@example.com", "password": "nope"})
    assert resp.status_code == 429


def test_change_password(make_client):
    client = make_client()
    other_device = as_user(client, ADMIN)
    assert client.post("/api/auth/password", json={"current_password": "bad",
                                                   "new_password": "new-pass-1"}).status_code == 400
    assert client.post("/api/auth/password", json={"current_password": ADMIN[1],
                                                   "new_password": "short"}).status_code == 422
    assert client.post("/api/auth/password", json={"current_password": ADMIN[1],
                                                   "new_password": "new-pass-1"}).status_code == 204
    assert client.get("/api/auth/me").status_code == 200  # this device stays signed in
    assert other_device.get("/api/auth/me").status_code == 401  # others are signed out
    sign_in(TestClient(client.app), ADMIN[0], "new-pass-1")


# --- recordings ---

def test_config(make_client):
    body = make_client().get("/api/config").json()
    assert body["providers"]["deepseek"]["reason"] == "no_api_key"
    assert body["defaults"] == {"provider": "auto", "summary": True, "summary_type": "auto"}
    assert [t["id"] for t in body["summary_types"]] == ["client", "meeting", "interview",
                                                         "one_on_one", "highlights"]
    assert body["summary_types"][2] == {"id": "interview", "label": "Собеседование",
                                        "description": body["summary_types"][2]["description"],
                                        "builtin": True, "sections": None}


def test_full_job_lifecycle(make_client, tmp_path):
    client = make_client()
    job_id = upload(client)
    job = wait_until(client, job_id, lambda j: j["status"] == "done")

    assert job["transcript"] == [{"start_sec": 0.0, "text": "привет"},
                                 {"start_sec": 1.5, "text": "как дела"}]
    assert job["summary"]["title"] == "Планёрка"
    assert job["provider_used"] == "ollama"
    assert {s["status"] for s in job["stages"].values()} == {"done"}
    assert job["progress_pct"] == 100

    assert client.get("/api/jobs").json()[0]["title"] == "Планёрка"

    resp = client.get(f"/api/jobs/{job_id}/download/transcript.txt")
    assert resp.text == "[00:00:00] привет\n[00:00:01] как дела\n"
    assert unquote(resp.headers["content-disposition"]).endswith(" Планёрка.txt")
    assert client.get(f"/api/jobs/{job_id}/download/summary.json").json()["title"] == "Планёрка"
    assert client.get(f"/api/jobs/{job_id}/download/other.txt").status_code == 404

    docx = client.get(f"/api/jobs/{job_id}/download/summary.docx")
    assert docx.content.startswith(b"PK")  # zip container
    assert unquote(docx.headers["content-disposition"]).endswith(" Планёрка.summary.docx")
    assert not (tmp_path / "jobs" / job_id / "summary.docx").exists()  # built on download

    digest = client.get(f"/api/jobs/{job_id}/download/digest.docx")
    assert digest.content.startswith(b"PK")
    assert unquote(digest.headers["content-disposition"]).endswith(" Планёрка.digest.docx")

    audio = client.get(f"/api/jobs/{job_id}/audio", headers={"Range": "bytes=0-3"})
    assert audio.status_code == 206
    assert audio.content == b"RIFF"


def test_jobs_are_private(make_client):
    admin = make_client()
    add_user(admin)
    anna = as_user(admin)
    job_id = upload(admin)
    wait_until(admin, job_id, lambda j: j["status"] == "done")

    assert anna.get("/api/jobs").json() == []
    for path in ("", "/audio", "/download/transcript.txt", "/events"):
        assert anna.get(f"/api/jobs/{job_id}{path}").status_code == 404, path
    assert anna.delete(f"/api/jobs/{job_id}").status_code == 404
    admin.app.state.stopping.set()  # so the stream ends after the snapshot
    body = anna.get("/api/events").text
    assert body.startswith('event: snapshot\ndata: {"jobs": []}')


def test_skipped_stages(make_client):
    client = make_client()
    job_id = upload(client, summary="false")
    job = wait_until(client, job_id, lambda j: j["status"] == "done")
    assert job["stages"]["summarizing"]["status"] == "skipped"
    assert job["transcript"][0]["text"] == "привет"
    assert job["summary"] is None


def test_rejects_unreadable_file(make_client, tmp_path):
    client = make_client()
    resp = client.post("/api/jobs", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert resp.status_code == 415
    assert resp.json()["detail"].startswith("Не удалось прочитать файл")
    assert not any((tmp_path / "jobs").iterdir())


def test_unknown_provider_or_type_rejected(make_client):
    client = make_client()
    for data in ({"provider": "gpt"}, {"summary_type": "lecture"}):
        resp = client.post("/api/jobs", files={"file": ("a.wav", b"x")}, data=data)
        assert resp.status_code == 422, data


def test_summary_type_passed_to_pipeline(make_client):
    pipeline = FakePipeline()
    client = make_client(pipeline)
    job_id = upload(client, summary_type="interview")
    job = wait_until(client, job_id, lambda j: j["status"] == "done")
    assert job["options"]["summary_type"] == "interview"
    assert pipeline.summarized_with == [("ollama", "interview")]


def test_no_speech_is_an_error(make_client):
    client = make_client(FakePipeline(phrases=[]))
    job_id = upload(client)
    job = wait_until(client, job_id, lambda j: j["status"] == "error")
    assert job["error"] == "В записи не найдено речи"
    assert job["stages"]["transcribing"]["status"] == "error"


def test_summary_error_keeps_transcript_and_can_be_retried(make_client):
    pipeline = FakePipeline(summary_error=RuntimeError("Ollama не отвечает"))
    client = make_client(pipeline)
    job_id = upload(client)
    job = wait_until(client, job_id, lambda j: j["status"] == "done")
    assert job["summary"] is None
    assert job["summary_error"] == "Ollama не отвечает"
    assert job["stages"]["summarizing"]["status"] == "error"
    assert len(job["transcript"]) == 2

    pipeline.summary_error = None
    assert client.post(f"/api/jobs/{job_id}/summary",
                       json={"provider": "deepseek", "summary_type": "meeting"}).status_code == 202
    job = wait_until(client, job_id, lambda j: j["status"] == "done" and j["summary"])
    assert job["summary_error"] is None
    assert job["provider_used"] == "deepseek"
    assert job["options"]["summary_type"] == "meeting"
    assert pipeline.summarized_with[-1] == ("deepseek", "meeting")


def test_delete(make_client, tmp_path):
    client = make_client()
    job_id = upload(client)
    wait_until(client, job_id, lambda j: j["status"] == "done")
    assert client.delete(f"/api/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert not (tmp_path / "jobs" / job_id).exists()


def test_events_for_finished_job(make_client):
    client = make_client()
    job_id = upload(client)
    wait_until(client, job_id, lambda j: j["status"] == "done")
    with client.stream("GET", f"/api/jobs/{job_id}/events") as resp:
        body = resp.read().decode()
    event, data = body.split("\n")[:2]
    assert event == "event: snapshot"
    assert json.loads(data.removeprefix("data: "))["status"] == "done"


def test_event_streams_end_on_shutdown(make_client):
    client = make_client()
    client.app.state.stopping.set()  # what Ctrl+C does in main()
    with client.stream("GET", "/api/events") as resp:
        assert resp.read().decode().startswith("event: snapshot")  # returns instead of hanging


def test_jobs_survive_restart_and_interrupted_ones_become_errors(make_client, make_app):
    client = make_client()
    job_id = upload(client)
    wait_until(client, job_id, lambda j: j["status"] == "done")
    manager = client.app.state.manager
    job = manager.jobs[job_id]
    job.status, job.stage = "running", "summarizing"
    job.stages["summarizing"]["status"] = "running"
    manager._save(job)

    restarted = TestClient(make_app())
    sign_in(restarted, *ADMIN)
    job = restarted.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "error"
    assert "перезапущен" in job["error"]
    assert job["stages"]["summarizing"]["status"] == "error"
    assert job["transcript"][0]["text"] == "привет"


def test_legacy_jobs_imported_for_first_admin(make_app, tmp_path):
    legacy = tmp_path / "jobs" / "20260101-120000-abcd"
    legacy.mkdir(parents=True)
    (legacy / "job.json").write_text(json.dumps({
        "id": legacy.name, "filename": "old.mp3", "source": "source.mp3",
        "created_at": "2026-01-01T12:00:00+03:00", "duration_sec": 60.0,
        "options": {"provider": "auto", "punctuation": True, "summary": True},
        "status": "done", "stage": None,
        "stages": {s: {"status": "done", "started_at": None, "finished_at": None}
                   for s in ("transcribing", "punctuating", "summarizing")},
        "transcript": [{"start_sec": 0.0, "text": "Старая запись."}], "summary": SUMMARY,
    }))
    client = TestClient(make_app())
    sign_in(client, *ADMIN)
    job = client.get(f"/api/jobs/{legacy.name}").json()
    assert job["transcript"][0]["text"] == "Старая запись."
    assert set(job["stages"]) == {"transcribing", "summarizing"}
    assert "punctuation" not in job["options"]
    again = make_app()  # the next start doesn't import it twice
    assert list(again.state.manager.jobs) == [legacy.name]


def test_frontend_fallbacks(make_client, tmp_path):
    client = make_client()
    assert client.get("/jobs/123").status_code == 503  # interface not built yet
    assert client.get("/api/nope").status_code == 404

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<div id=root></div>")
    (dist / "app.js").write_text("console.log(1)")
    assert client.get("/jobs/123").text == "<div id=root></div>"  # SPA route
    assert client.get("/app.js").text == "console.log(1)"
    assert client.get("/../pyproject.toml").text == "<div id=root></div>"  # no traversal


# --- admin: users ---

def test_admin_api_is_admin_only(make_client):
    admin = make_client()
    add_user(admin)
    anna = as_user(admin)
    for path in ("/api/admin/users", "/api/admin/settings", "/api/admin/usage",
                 "/api/admin/summary-types"):
        assert anna.get(path).status_code == 403, path


def test_admin_manages_users(make_client):
    admin = make_client()
    user = add_user(admin)
    assert user["role"] == "user" and user["is_active"] and user["jobs_count"] == 0
    resp = admin.post("/api/admin/users", json={"email": USER[0].upper(), "password": "x" * 8})
    assert resp.status_code == 409
    assert admin.post("/api/admin/users", json={"email": "b@example.com",
                                                "password": "short"}).status_code == 422

    anna = as_user(admin)
    resp = admin.patch(f"/api/admin/users/{user['id']}", json={"is_active": False})
    assert resp.json()["is_active"] is False
    assert anna.get("/api/auth/me").status_code == 401  # signed out immediately
    resp = TestClient(admin.app).post("/api/auth/login",
                                      json={"email": USER[0], "password": USER[1]})
    assert resp.status_code == 403

    admin.patch(f"/api/admin/users/{user['id']}", json={"is_active": True, "password": "new-pass-2",
                                                         "role": "admin", "name": "Анна К."})
    assert sign_in(TestClient(admin.app), USER[0], "new-pass-2")["role"] == "admin"

    me = admin.get("/api/auth/me").json()
    for patch in ({"is_active": False}, {"role": "user"}):
        assert admin.patch(f"/api/admin/users/{me['id']}", json=patch).status_code == 409


def test_admin_sees_job_metadata_but_not_content(make_client):
    admin = make_client()
    user = add_user(admin)
    anna = as_user(admin)
    job_id = upload(anna, summary_type="interview")
    wait_until(anna, job_id, lambda j: j["status"] == "done")

    jobs = admin.get(f"/api/admin/users/{user['id']}/jobs").json()
    assert jobs == [{"id": job_id, "filename": "call.wav", "created_at": jobs[0]["created_at"],
                     "duration_sec": 2.0, "status": "done", "summary_type": "interview",
                     "provider_used": "ollama"}]
    assert admin.get(f"/api/jobs/{job_id}").status_code == 404
    users = {u["email"]: u for u in admin.get("/api/admin/users").json()}
    assert users[USER[0]]["jobs_count"] == 1
    assert users[USER[0]]["audio_sec"] == 2.0
    assert users[USER[0]]["tokens_total"] == 1200


# --- admin: usage ---

def test_usage_by_user_and_model(make_client):
    admin = make_client()
    user = add_user(admin)
    anna = as_user(admin)
    for client in (admin, anna, anna):
        job_id = upload(client)
        wait_until(client, job_id, lambda j: j["status"] == "done")

    usage = admin.get("/api/admin/usage?days=7").json()
    assert usage["totals"] == {"prompt_tokens": 3000, "completion_tokens": 600, "requests": 3,
                               "audio_sec": 6.0}
    by_user = {u["email"]: u for u in usage["by_user"]}
    assert by_user[USER[0]]["requests"] == 2 and by_user[USER[0]]["audio_sec"] == 4.0
    assert usage["by_model"] == [{"provider": "ollama", "model": "fake-model",
                                  "prompt_tokens": 3000, "completion_tokens": 600, "requests": 3}]
    assert {(r["user_id"], r["requests"]) for r in usage["by_user_model"]} == \
        {(user["id"], 2), (by_user[ADMIN[0]]["user_id"], 1)}
    assert usage["daily"][0]["provider"] == "ollama"
    assert admin.get("/api/admin/usage?days=0").status_code == 422


# --- admin: settings ---

def test_settings_precedence_and_encrypted_key(make_client):
    pipeline = FakePipeline()
    admin = make_client(pipeline, env={"DEEPSEEK_MODEL": "deepseek-v4-pro"})
    items = {i["key"]: i for i in admin.get("/api/admin/settings").json()["items"]}
    assert items["deepseek_model"]["value"] == "deepseek-v4-pro"
    assert items["deepseek_model"]["source"] == "env"
    assert items["whisper_language"]["value"] == "ru"
    assert items["whisper_language"]["source"] == "default"
    assert items["deepseek_api_key"]["value"] is None

    resp = admin.put("/api/admin/settings", json={"deepseek_api_key": "sk-1234567890abcd",
                                                  "ollama_model": "qwen3.5:9b",
                                                  "whisper_language": "AUTO"})
    items = {i["key"]: i for i in resp.json()["items"]}
    assert items["deepseek_api_key"]["value"] == "sk-…abcd"
    assert items["deepseek_api_key"]["source"] == "db"
    assert items["whisper_language"]["value"] == "auto"

    with admin.app.state.sessions() as db:
        stored = db.scalar(select(Setting.value).where(Setting.key == "deepseek_api_key"))
    assert "1234567890" not in stored  # encrypted at rest

    admin.get("/api/config")
    assert pipeline.configs[-1].deepseek_api_key == "sk-1234567890abcd"
    assert pipeline.configs[-1].ollama_model == "qwen3.5:9b"
    job_id = upload(admin)
    wait_until(admin, job_id, lambda j: j["status"] == "done")
    assert pipeline.languages == [None]  # auto → autodetect

    resp = admin.put("/api/admin/settings", json={"ollama_model": None, "deepseek_api_key": ""})
    items = {i["key"]: i for i in resp.json()["items"]}
    assert items["ollama_model"]["source"] == "default"
    assert items["deepseek_api_key"]["value"] is None

    for bad in ({"ollama_max_context": "много"}, {"ollama_max_context": 10},
                {"whisper_language": "русский"}, {"nope": 1}):
        assert admin.put("/api/admin/settings", json=bad).status_code == 422, bad


# --- admin: summary types ---

CUSTOM = {
    "id": "retro", "label": "Ретроспектива", "description": "ретро спринта: что было хорошо и плохо",
    "prompt": "## Тип записи: ретроспектива\n\nФиксируй выводы команды.",
    "sections": [{"key": "went_well", "title": "Что получилось", "description": "успехи"},
                 {"key": "to_improve", "title": "Что улучшить", "description": ""}],
}


def test_custom_summary_type(make_client):
    admin = make_client()
    resp = admin.post("/api/admin/summary-types", json=CUSTOM)
    assert resp.status_code == 201, resp.text
    assert resp.json()["builtin"] is False and resp.json()["jobs_count"] == 0
    assert admin.post("/api/admin/summary-types", json=CUSTOM).status_code == 409
    assert admin.post("/api/admin/summary-types",
                      json={**CUSTOM, "id": "meeting"}).status_code == 409
    for bad in ({"id": "Retro"}, {"sections": []},
                {"sections": [CUSTOM["sections"][0], CUSTOM["sections"][0]]}):
        assert admin.post("/api/admin/summary-types", json={**CUSTOM, **bad}).status_code == 422

    listed = admin.get("/api/config").json()["summary_types"][-1]
    assert listed == {"id": "retro", "label": "Ретроспектива", "description": CUSTOM["description"],
                      "builtin": False, "sections": [{"key": "went_well", "title": "Что получилось"},
                                                     {"key": "to_improve", "title": "Что улучшить"}]}

    job_id = upload(admin, summary_type="retro")
    job = wait_until(admin, job_id, lambda j: j["status"] == "done")
    assert job["summary"]["details"] == {"went_well": ["пункт"], "to_improve": ["пункт"]}
    md = admin.get(f"/api/jobs/{job_id}/download/summary.md").text
    assert "**Тип:** Ретроспектива" in md and "## Что получилось\n\n- пункт" in md

    assert admin.delete("/api/admin/summary-types/retro").status_code == 409  # in use
    resp = admin.put("/api/admin/summary-types/retro", json={"enabled": False})
    assert resp.json()["enabled"] is False and resp.json()["jobs_count"] == 1
    assert "retro" not in [t["id"] for t in admin.get("/api/config").json()["summary_types"]]
    resp = admin.post("/api/jobs", files={"file": ("a.wav", b"x")}, data={"summary_type": "retro"})
    assert resp.status_code == 422
    assert admin.get(f"/api/jobs/{job_id}").json()["summary"]["meeting_type"] == "retro"

    admin.delete(f"/api/jobs/{job_id}")
    assert admin.delete("/api/admin/summary-types/retro").status_code == 204
    assert admin.delete("/api/admin/summary-types/meeting").status_code == 409


def test_builtin_prompt_override_and_base_prompt(make_client):
    admin = make_client()
    default = admin.get("/api/admin/summary-types").json()[1]
    assert default["id"] == "meeting" and not default["prompt_modified"]

    resp = admin.put("/api/admin/summary-types/meeting", json={"prompt": "Новые правила"})
    assert resp.json()["prompt"] == "Новые правила" and resp.json()["prompt_modified"]
    registry = admin.app.state.types.registry()
    assert registry.system_prompt("meeting").endswith("Новые правила")
    assert admin.put("/api/admin/summary-types/meeting",
                     json={"label": "Другое"}).status_code == 422  # built-in: prompt/enabled only
    resp = admin.put("/api/admin/summary-types/meeting", json={"prompt": None})
    assert resp.json()["prompt"] == default["prompt"] and not resp.json()["prompt_modified"]

    base = admin.get("/api/admin/base-prompt").json()
    assert not base["modified"] and base["prompt"] == base["default_prompt"]
    assert admin.put("/api/admin/base-prompt", json={"prompt": "Общие правила v2"}).json()["modified"]
    assert admin.app.state.types.registry().system_prompt("client").startswith("Общие правила v2")
    assert not admin.put("/api/admin/base-prompt", json={"prompt": None}).json()["modified"]


def test_last_enabled_type_cannot_be_disabled(make_client):
    admin = make_client()
    for type_id in ("client", "meeting", "interview", "one_on_one"):
        assert admin.put(f"/api/admin/summary-types/{type_id}",
                         json={"enabled": False}).status_code == 200
    resp = admin.put("/api/admin/summary-types/highlights", json={"enabled": False})
    assert resp.status_code == 409
