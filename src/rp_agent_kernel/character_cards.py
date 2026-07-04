from __future__ import annotations

import base64
import json
import re
import struct
import zlib
from pathlib import Path
from typing import Any

from .models import CharacterCreate


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class CharacterCardError(ValueError):
    pass


def parse_character_card(
    *, file_name: str, content: str | None = None, content_base64: str | None = None
) -> tuple[CharacterCreate, str, list[str]]:
    raw_bytes = _decode_input(content, content_base64)
    warnings: list[str] = []

    if raw_bytes.startswith(PNG_SIGNATURE):
        payload, png_warnings = _extract_png_character_payload(raw_bytes)
        warnings.extend(png_warnings)
        data = _loads_character_json(payload)
        parsed_format = "tavern_png"
    else:
        text = raw_bytes.decode("utf-8-sig")
        data = _loads_character_json(text)
        parsed_format = _detect_json_format(data)

    character = _to_character_create(data, file_name=file_name, parsed_format=parsed_format)
    if not character.name:
        character.name = Path(file_name).stem or "Imported Character"
        warnings.append("角色卡缺少 name，已使用文件名。")
    return character, parsed_format, warnings


def _decode_input(content: str | None, content_base64: str | None) -> bytes:
    if content_base64:
        value = content_base64.split(",", 1)[-1]
        return base64.b64decode(value)
    if content is not None:
        return content.encode("utf-8")
    raise CharacterCardError("missing character card content")


def _loads_character_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise CharacterCardError("empty character card content")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        try:
            decoded = base64.b64decode(stripped).decode("utf-8-sig")
            return json.loads(decoded)
        except Exception as exc:
            raise CharacterCardError("character card is not valid JSON") from exc


def _detect_json_format(data: dict[str, Any]) -> str:
    if "spec" in data and "data" in data:
        return str(data.get("spec") or "character_card_v2")
    if "char_name" in data or "char_persona" in data:
        return "tavern_legacy_json"
    return "generic_json"


def _extract_png_character_payload(raw_bytes: bytes) -> tuple[str, list[str]]:
    warnings: list[str] = []
    offset = len(PNG_SIGNATURE)
    while offset + 12 <= len(raw_bytes):
        length = struct.unpack(">I", raw_bytes[offset : offset + 4])[0]
        chunk_type = raw_bytes[offset + 4 : offset + 8]
        data = raw_bytes[offset + 8 : offset + 8 + length]
        offset += 12 + length

        keyword = ""
        value = ""
        if chunk_type == b"tEXt":
            keyword, value = _parse_text_chunk(data)
        elif chunk_type == b"zTXt":
            keyword, value = _parse_ztxt_chunk(data)
        elif chunk_type == b"iTXt":
            keyword, value = _parse_itxt_chunk(data)
        else:
            continue

        if keyword.lower() in {"chara", "ccv3", "character"}:
            return _decode_png_text_value(value), warnings

    raise CharacterCardError("PNG does not contain Tavern character metadata")


def _parse_text_chunk(data: bytes) -> tuple[str, str]:
    keyword, _, value = data.partition(b"\x00")
    return keyword.decode("latin-1", errors="replace"), value.decode("latin-1", errors="replace")


def _parse_ztxt_chunk(data: bytes) -> tuple[str, str]:
    keyword, _, rest = data.partition(b"\x00")
    if not rest:
        return keyword.decode("latin-1", errors="replace"), ""
    compression_method = rest[0]
    compressed = rest[1:]
    if compression_method != 0:
        return keyword.decode("latin-1", errors="replace"), ""
    return (
        keyword.decode("latin-1", errors="replace"),
        zlib.decompress(compressed).decode("utf-8", errors="replace"),
    )


def _parse_itxt_chunk(data: bytes) -> tuple[str, str]:
    parts = data.split(b"\x00", 5)
    if len(parts) < 6:
        return "", ""
    keyword, compression_flag, compression_method, _language, _translated, value = parts
    if compression_flag == b"\x01" and compression_method == b"\x00":
        value = zlib.decompress(value)
    return keyword.decode("utf-8", errors="replace"), value.decode("utf-8", errors="replace")


def _decode_png_text_value(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("{"):
        return stripped
    return base64.b64decode(stripped).decode("utf-8-sig")


def _to_character_create(
    data: dict[str, Any], *, file_name: str, parsed_format: str
) -> CharacterCreate:
    payload = data.get("data") if isinstance(data.get("data"), dict) else data

    name = _first_text(payload, "name", "char_name", "display_name")
    description = _first_text(payload, "description", "char_persona", "persona")
    personality = _first_text(payload, "personality")
    scenario = _first_text(payload, "scenario", "world_scenario")
    system_prompt = _first_text(payload, "system_prompt", "systemPrompt")
    post_history = _first_text(payload, "post_history_instructions", "postHistoryInstructions")

    persona_parts = [
        part
        for part in (description, personality, system_prompt, post_history)
        if part and part.strip()
    ]
    tags = _normalize_tags(payload.get("tags") or payload.get("tag_list") or [])

    metadata_keys = (
        "first_mes",
        "first_message",
        "mes_example",
        "creator_notes",
        "creator",
        "character_version",
        "extensions",
        "character_book",
    )
    metadata = {
        "sourceFile": file_name,
        "importFormat": parsed_format,
        "rawSpec": data.get("spec"),
        "rawSpecVersion": data.get("spec_version"),
    }
    for key in metadata_keys:
        if key in payload:
            metadata[key] = payload[key]

    return CharacterCreate(
        name=name,
        persona="\n\n".join(persona_parts),
        scenario=scenario,
        tags=tags,
        metadata={key: value for key, value in metadata.items() if value not in (None, "")},
    )


def _first_text(data: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str):
            return value.strip()
    return ""


def _normalize_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item for item in re.split(r"[,，\s]+", value) if item]
    return []
