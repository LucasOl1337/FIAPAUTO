from __future__ import annotations

from itertools import cycle
from threading import Lock
from typing import Optional

# Lista de chaves usadas em sequência (nome, valor).
_KEYS = [
    ("Kroco", "04fb9ba4da6f4725acd285285d487d45.Az7I4Zq2Xv0zXkVJ6BJVsZbb"),
    ("Kled", "20a4f67f87b949e6ae51b56c575614f5.LKmv3kQAJLc4lVvqvRpCLIKk"),
    ("Unkro", "8ac959e485ef4be293ae0a3f73669aee.S_koGMxakJuO6ioSXZeLQo3e"), 
    ("lol", "82a0d0550d814a249793098e86926bdc.vyBYFgHrZZ5svMdV6nXTRpxd")
]

_lock = Lock()
_iterator = cycle(_KEYS) if _KEYS else None
_last_key: Optional[tuple[str, str]] = None

def has_keys() -> bool:
    return bool(_KEYS)

def _advance() -> Optional[tuple[str, str]]:
    if not _iterator:
        return None
    global _last_key
    with _lock:
        name, key = next(_iterator)
        if _last_key and len(_KEYS) > 1:
            while key == _last_key[1]:
                name, key = next(_iterator)
        _last_key = (name, key)
        return name, key

def get_next_key() -> Optional[str]:
    pair = _advance()
    return pair[1] if pair else None

def get_next_key_with_name() -> Optional[tuple[str, str]]:
    return _advance()
