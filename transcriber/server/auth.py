"""Sign-in with email and password, cookie sessions, the current-user dependencies."""

import os
from dataclasses import dataclass
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import sessionmaker

from .db import User, UserSession, utcnow
from .security import (SESSION_COOKIE, SESSION_DAYS, LoginThrottle, check_password_strength,
                       hash_password, new_session_token, token_hash, verify_password)


@dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    name: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name, "role": self.role}


def normalize_email(email: str) -> str:
    return email.strip().lower()


def create_user(sessions: sessionmaker, email: str, name: str, password: str,
                role: str = "user") -> User:
    """Raises ValueError on invalid input, LookupError if the email is taken."""
    email = normalize_email(email)
    if "@" not in email or len(email) > 254:
        raise ValueError("Некорректный email")
    if role not in ("admin", "user"):
        raise ValueError("Роль: admin или user")
    check_password_strength(password)
    with sessions.begin() as db:
        if db.scalar(select(User).where(User.email == email)):
            raise LookupError(f"Пользователь {email} уже есть")
        user = User(email=email, name=name.strip() or email.split("@")[0],
                    password_hash=hash_password(password), role=role)
        db.add(user)
    return user


def bootstrap_admin(sessions: sessionmaker, env) -> None:
    """First start: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users."""
    email, password = env.get("ADMIN_EMAIL"), env.get("ADMIN_PASSWORD")
    if not (email and password):
        return
    with sessions() as db:
        if db.scalar(select(func.count()).select_from(User)):
            return
    create_user(sessions, email, env.get("ADMIN_NAME", ""), password, role="admin")


def first_admin_id(sessions: sessionmaker) -> int | None:
    with sessions() as db:
        return db.scalar(select(User.id).where(User.role == "admin").order_by(User.id).limit(1))


# --- dependencies ---

def current_user(request: Request) -> CurrentUser:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(401, "Нужно войти")
    sessions: sessionmaker = request.app.state.sessions
    now = utcnow()
    with sessions.begin() as db:
        session = db.get(UserSession, token_hash(token))
        expires = session and session.expires_at
        if expires and expires.tzinfo is None:  # SQLite
            expires = expires.replace(tzinfo=now.tzinfo)
        if not session or expires < now:
            raise HTTPException(401, "Нужно войти")
        user = db.get(User, session.user_id)
        if not user or not user.is_active:
            raise HTTPException(401, "Нужно войти")
        # Sliding expiry, written at most once a day.
        if expires - now < timedelta(days=SESSION_DAYS - 1):
            session.expires_at = now + timedelta(days=SESSION_DAYS)
        return CurrentUser(user.id, user.email, user.name, user.role)


def admin_user(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Нужны права администратора")
    return user


# --- routes ---

class LoginRequest(BaseModel):
    email: str
    password: str


class PasswordRequest(BaseModel):
    current_password: str
    new_password: str


router = APIRouter(prefix="/api/auth")
throttle = LoginThrottle()


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
        # COOKIE_SECURE=1 behind HTTPS; plain http://localhost needs it off.
        secure=os.getenv("COOKIE_SECURE") == "1", path="/",
    )


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response):
    email = normalize_email(body.email)
    ip = request.client.host if request.client else ""
    if wait := throttle.retry_after(email, ip):
        raise HTTPException(429, f"Слишком много попыток. Попробуйте через {-(-wait // 60)} мин.")
    sessions: sessionmaker = request.app.state.sessions
    with sessions.begin() as db:
        user = db.scalar(select(User).where(User.email == email))
        if not user or not verify_password(user.password_hash, body.password):
            throttle.failed(email, ip)
            raise HTTPException(401, "Неверный email или пароль")
        if not user.is_active:
            raise HTTPException(403, "Учётная запись отключена — обратитесь к администратору")
        throttle.succeeded(email, ip)
        token, hashed = new_session_token()
        db.add(UserSession(token_hash=hashed, user_id=user.id,
                           expires_at=utcnow() + timedelta(days=SESSION_DAYS)))
        user.last_login_at = utcnow()
        me = CurrentUser(user.id, user.email, user.name, user.role)
    _set_cookie(response, token)
    return me.public()


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    if token := request.cookies.get(SESSION_COOKIE):
        with request.app.state.sessions.begin() as db:
            db.execute(delete(UserSession).where(UserSession.token_hash == token_hash(token)))
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me")
def me(user: CurrentUser = Depends(current_user)):
    return user.public()


@router.post("/password", status_code=204)
def change_password(body: PasswordRequest, request: Request,
                    user: CurrentUser = Depends(current_user)):
    try:
        check_password_strength(body.new_password)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    current_token = token_hash(request.cookies.get(SESSION_COOKIE, ""))
    with request.app.state.sessions.begin() as db:
        record = db.get(User, user.id)
        if not verify_password(record.password_hash, body.current_password):
            raise HTTPException(400, "Текущий пароль неверный")
        record.password_hash = hash_password(body.new_password)
        # Sign out other devices, keep this one.
        db.execute(delete(UserSession).where(UserSession.user_id == user.id,
                                             UserSession.token_hash != current_token))
