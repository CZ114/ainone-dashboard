"""Hardcoded list of available extensions.

A more dynamic discovery (scan a directory, load manifests) is explicit
future work — keep this simple while the list is tiny.
"""
from typing import List, Optional, Type

from app.extensions.base import Extension
from app.extensions.whisper_local import WhisperLocalExtension

REGISTRY: List[Type[Extension]] = [
    WhisperLocalExtension,
]


def get_extension_class(ext_id: str) -> Optional[Type[Extension]]:
    for cls in REGISTRY:
        if cls.id == ext_id:
            return cls
    return None


def list_registry() -> List[Type[Extension]]:
    return list(REGISTRY)
