"""Passwords, session tokens, login throttling and encryption of stored secrets."""

import base64
import hashlib
import os
import secrets
import threading
import time
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

MIN_PASSWORD_LENGTH = 8
SESSION_COOKIE = "session"
SESSION_DAYS = 30

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def check_password_strength(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Пароль должен быть не короче {MIN_PASSWORD_LENGTH} символов")


def new_session_token() -> tuple[str, str]:
    """(token for the cookie, its hash for the database)."""
    token = secrets.token_urlsafe(32)
    return token, token_hash(token)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginThrottle:
    """At most MAX_FAILURES wrong passwords per email+IP within WINDOW seconds."""

    MAX_FAILURES = 5
    WINDOW = 600

    def __init__(self):
        self._failures: dict[tuple[str, str], list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: tuple[str, str]) -> list[float]:
        now = time.monotonic()
        recent = [t for t in self._failures.get(key, []) if now - t < self.WINDOW]
        self._failures[key] = recent
        return recent

    def retry_after(self, email: str, ip: str) -> int | None:
        """Seconds until the next attempt is allowed, or None if it's allowed now."""
        with self._lock:
            recent = self._recent((email, ip))
            if len(recent) < self.MAX_FAILURES:
                return None
            return int(self.WINDOW - (time.monotonic() - recent[0])) + 1

    def failed(self, email: str, ip: str) -> None:
        with self._lock:
            self._recent((email, ip)).append(time.monotonic())

    def succeeded(self, email: str, ip: str) -> None:
        with self._lock:
            self._failures.pop((email, ip), None)


class SecretBox:
    """Encrypts API keys stored in the database with a key derived from SECRET_KEY.

    Without SECRET_KEY a random key is generated once into `key_file` (instance/secret_key,
    mounted as a volume in Docker); lose that file and the stored API keys can't be read.
    """

    def __init__(self, secret: str | None = None, key_file: Path | None = None):
        secret = secret or os.getenv("SECRET_KEY") or self._file_secret(key_file)
        key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
        self._fernet = Fernet(key)

    @staticmethod
    def _file_secret(key_file: Path | None) -> str:
        if key_file is None:
            raise RuntimeError("SECRET_KEY не задан")
        if not key_file.exists():
            key_file.parent.mkdir(parents=True, exist_ok=True)
            key_file.write_text(secrets.token_urlsafe(48))
            key_file.chmod(0o600)
        return key_file.read_text().strip()

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, value: str) -> str | None:
        """None if the value was encrypted with another SECRET_KEY."""
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            return None
