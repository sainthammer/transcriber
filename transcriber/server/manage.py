"""transcriber-admin: user management from the command line (e.g. the first admin)."""

import argparse
import getpass
import sys

from dotenv import load_dotenv
from sqlalchemy import delete, select

from .auth import create_user, normalize_email
from .db import User, UserSession, database_url, make_engine, make_sessionmaker, migrate
from .security import check_password_strength, hash_password


def _password(args) -> str:
    if args.password_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Пароль: ")
    if getpass.getpass("Ещё раз: ") != first:
        sys.exit("Пароли не совпадают")
    return first


def main():
    parser = argparse.ArgumentParser(prog="transcriber-admin",
                                     description="Пользователи веб-интерфейса")
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create-user", help="создать пользователя")
    create.add_argument("email")
    create.add_argument("--name", default="")
    create.add_argument("--admin", action="store_true", help="с правами администратора")
    create.add_argument("--password-stdin", action="store_true",
                        help="прочитать пароль из stdin (для скриптов)")

    password = commands.add_parser("set-password",
                                   help="сменить пароль (и выйти со всех устройств)")
    password.add_argument("email")
    password.add_argument("--password-stdin", action="store_true")

    commands.add_parser("list-users", help="список пользователей")
    commands.add_parser("migrate", help="обновить схему базы")
    args = parser.parse_args()

    load_dotenv()
    engine = make_engine(database_url())
    migrate(engine)
    sessions = make_sessionmaker(engine)

    if args.command == "create-user":
        try:
            user = create_user(sessions, args.email, args.name, _password(args),
                               role="admin" if args.admin else "user")
        except (ValueError, LookupError) as e:
            sys.exit(str(e))
        print(f"Создан {'администратор' if args.admin else 'пользователь'} {user.email}")
    elif args.command == "set-password":
        new = _password(args)
        try:
            check_password_strength(new)
        except ValueError as e:
            sys.exit(str(e))
        with sessions.begin() as db:
            user = db.scalar(select(User).where(User.email == normalize_email(args.email)))
            if user is None:
                sys.exit(f"Нет пользователя {args.email}")
            user.password_hash = hash_password(new)
            db.execute(delete(UserSession).where(UserSession.user_id == user.id))
        print("Пароль изменён")
    elif args.command == "list-users":
        with sessions() as db:
            for u in db.scalars(select(User).order_by(User.id)):
                state = "" if u.is_active else "  (отключён)"
                print(f"{u.id:>4}  {u.role:<5}  {u.email}  {u.name}{state}")
    else:
        print("Схема базы актуальна")


if __name__ == "__main__":
    main()
