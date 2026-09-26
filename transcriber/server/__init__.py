"""Web server: accounts, recordings of each user, admin API. Entry points: create_app, main."""

from .app import create_app, main

__all__ = ["create_app", "main"]
