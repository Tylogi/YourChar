from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from .intent import include_authoritative_real_state
from .models import FeatureName, MessageRequest
from .storage import Storage
from .timeparse import ensure_tz
from .tools import ExecutionResult


class ExternalModelError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExternalModelResult:
    content: str
    model: str
    usage: dict[str, Any]
    log_id: str | None = None
    reasoning_content: str = ""


@dataclass
class ExternalModelStreamState:
    content: str = ""
    reasoning_content: str = ""
    model: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    log_id: str | None = None


@dataclass
class _VisibleText:
    text: str
    sanitized: bool = False
    reason: str | None = None
    raw_text: str = ""


@dataclass
class _StreamVisibleFilter:
    request: MessageRequest
    execution: ExecutionResult
    fallback_reply: str | None = None
    pending: str = ""
    raw_content: str = ""
    mode: str = "undecided"
    sanitized: bool = False
    sanitize_reason: str | None = None

    def push(self, delta: str) -> list[str]:
        self.raw_content += delta
        if self.mode == "buffer":
            self.pending += delta
            return []
        if self.mode == "stream":
            return [delta]

        self.pending += delta
        if _content_prefix_requires_full_buffer(self.pending):
            self.mode = "buffer"
            return []
        if _content_prefix_ready_to_stream(self.pending):
            self.mode = "stream"
            visible = self.pending
            self.pending = ""
            return [visible]
        return []

    def finish(self) -> _VisibleText:
        if self.mode == "stream":
            return _VisibleText(text="", raw_text=self.raw_content)

        visible = _sanitize_visible_content(
            self.raw_content,
            self.request,
            self.execution,
            fallback_reply=self.fallback_reply,
        )
        self.sanitized = visible.sanitized
        self.sanitize_reason = visible.reason
        return visible


class OpenAICompatibleClient:
    def __init__(self, timeout: float = 45.0) -> None:
        self.timeout = timeout

    def render(
        self,
        *,
        storage: Storage,
        session_id: str,
        request: MessageRequest,
        execution: ExecutionResult,
        config: dict[str, Any],
        fallback_reply: str | None = None,
    ) -> ExternalModelResult:
        _validate_config(config)
        payload: dict[str, Any] = {
            "model": config["model"],
            "messages": _build_messages(storage, session_id, request, execution),
        }
        prompt_layout = _prompt_layout_metrics(payload["messages"])
        if config.get("temperature") is not None:
            payload["temperature"] = config["temperature"]
        if config.get("max_tokens") is not None:
            payload["max_tokens"] = config["max_tokens"]
        endpoint = _completion_url(config["base_url"])
        log = storage.create_model_call_log(
            provider="openai_compatible",
            session_id=session_id,
            mode=request.mode,
            character_id=request.character_id,
            model=str(config["model"]),
            endpoint=endpoint,
            request=payload,
            prompt_token_estimate=_prompt_token_estimate(payload),
        )

        headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "authorization": f"Bearer {config['api_key']}",
            **(config.get("headers") or {}),
        }
        try:
            response = _post_json(endpoint, payload, headers, timeout=self.timeout)
            raw_content = _extract_content(response)
            visible = _sanitize_visible_content(
                raw_content,
                request,
                execution,
                fallback_reply=fallback_reply,
            )
            content = visible.text
            reasoning_content = _extract_reasoning_content(response)
            reasoning_content = _merge_reasoning_content(
                reasoning_content,
                _extract_inline_reasoning_content(raw_content),
            )
        except ExternalModelError as exc:
            storage.complete_model_call_log(
                log.id,
                status="failed",
                response={},
                completion_text="",
                error=str(exc),
            )
            raise
        storage.complete_model_call_log(
            log.id,
            status="completed",
            response={
                "model": response.get("model") or config["model"],
                "usage": response.get("usage") if isinstance(response.get("usage"), dict) else {},
                "reasoningContent": reasoning_content,
                "visibleSanitized": visible.sanitized,
                "sanitizeReason": visible.reason,
                "promptLayout": prompt_layout,
                **({"rawCompletionText": visible.raw_text} if visible.sanitized else {}),
                "raw": response,
            },
            completion_text=content,
        )
        return ExternalModelResult(
            content=content,
            model=str(response.get("model") or config["model"]),
            usage=response.get("usage") if isinstance(response.get("usage"), dict) else {},
            log_id=log.id,
            reasoning_content=reasoning_content,
        )

    def stream_render(
        self,
        *,
        storage: Storage,
        session_id: str,
        request: MessageRequest,
        execution: ExecutionResult,
        config: dict[str, Any],
        state: ExternalModelStreamState,
        fallback_reply: str | None = None,
    ) -> Iterator[str]:
        _validate_config(config)
        state.model = str(config["model"])
        payload: dict[str, Any] = {
            "model": config["model"],
            "messages": _build_messages(storage, session_id, request, execution),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        prompt_layout = _prompt_layout_metrics(payload["messages"])
        if config.get("temperature") is not None:
            payload["temperature"] = config["temperature"]
        if config.get("max_tokens") is not None:
            payload["max_tokens"] = config["max_tokens"]
        endpoint = _completion_url(config["base_url"])
        log = storage.create_model_call_log(
            provider="openai_compatible",
            session_id=session_id,
            mode=request.mode,
            character_id=request.character_id,
            model=str(config["model"]),
            endpoint=endpoint,
            request=payload,
            prompt_token_estimate=_prompt_token_estimate(payload),
        )
        state.log_id = log.id

        headers = {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "authorization": f"Bearer {config['api_key']}",
            **(config.get("headers") or {}),
        }
        chunks: list[str] = []
        raw_chunks: list[str] = []
        reasoning_chunks: list[str] = []
        visible_filter = _StreamVisibleFilter(
            request=request,
            execution=execution,
            fallback_reply=fallback_reply,
        )
        try:
            for chunk in _post_stream_json(endpoint, payload, headers, timeout=self.timeout):
                if isinstance(chunk.get("model"), str):
                    state.model = chunk["model"]
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    state.usage = usage
                reasoning_delta = _extract_reasoning_delta(chunk)
                if reasoning_delta:
                    state.reasoning_content += reasoning_delta
                    reasoning_chunks.append(reasoning_delta)
                delta = _extract_delta(chunk)
                if not delta:
                    continue
                raw_chunks.append(delta)
                for visible_delta in visible_filter.push(delta):
                    if not state.content:
                        visible_delta = visible_delta.lstrip()
                    if not visible_delta:
                        continue
                    state.content += visible_delta
                    chunks.append(visible_delta)
                    yield visible_delta
        except ExternalModelError as exc:
            storage.complete_model_call_log(
                log.id,
                status="failed",
                response={
                    "stream": True,
                    "model": state.model or config["model"],
                    "usage": state.usage,
                    "chunks": chunks,
                    "rawChunks": raw_chunks,
                    "rawCompletionText": visible_filter.raw_content,
                    "reasoningContent": state.reasoning_content,
                    "reasoningChunks": reasoning_chunks,
                    "promptLayout": prompt_layout,
                },
                completion_text=state.content,
                error=str(exc),
            )
            raise
        final_visible = visible_filter.finish()
        inline_reasoning = _extract_inline_reasoning_content(visible_filter.raw_content)
        if inline_reasoning:
            state.reasoning_content = _merge_reasoning_content(
                state.reasoning_content, inline_reasoning
            )
            if inline_reasoning not in reasoning_chunks:
                reasoning_chunks.append(inline_reasoning)
        if final_visible.text:
            state.content += final_visible.text
            chunks.append(final_visible.text)
            yield final_visible.text
        storage.complete_model_call_log(
            log.id,
            status="completed",
            response={
                "stream": True,
                "model": state.model or config["model"],
                "usage": state.usage,
                "chunks": chunks,
                **(
                    {
                        "rawChunks": raw_chunks,
                        "rawCompletionText": final_visible.raw_text,
                        "visibleSanitized": True,
                        "sanitizeReason": final_visible.reason,
                    }
                    if final_visible.sanitized
                    else {}
                ),
                "reasoningContent": state.reasoning_content,
                "reasoningChunks": reasoning_chunks,
                "chunkCount": len(chunks),
                "promptLayout": prompt_layout,
            },
            completion_text=state.content,
        )

    def list_models(self, *, config: dict[str, Any]) -> list[str]:
        _validate_model_list_config(config)
        headers = {
            "accept": "application/json",
            "authorization": f"Bearer {config['api_key']}",
            **(config.get("headers") or {}),
        }
        response = _get_json(_models_url(config["base_url"]), headers, timeout=self.timeout)
        return _extract_model_ids(response)


def _validate_config(config: dict[str, Any]) -> None:
    missing = [
        name
        for name in ("base_url", "api_key", "model")
        if not str(config.get(name) or "").strip()
    ]
    if missing:
        raise ExternalModelError("external model config missing: " + ", ".join(missing))


def _validate_model_list_config(config: dict[str, Any]) -> None:
    missing = [
        name
        for name in ("base_url", "api_key")
        if not str(config.get(name) or "").strip()
    ]
    if missing:
        raise ExternalModelError("external model config missing: " + ", ".join(missing))


def _completion_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    return cleaned + "/chat/completions"


def _models_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if cleaned.endswith("/models"):
        return cleaned
    if cleaned.endswith("/chat/completions"):
        return cleaned[: -len("/chat/completions")] + "/models"
    return cleaned + "/models"


def _get_json(url: str, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ExternalModelError(f"external model HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ExternalModelError(_format_url_error(exc.reason)) from exc
    except TimeoutError as exc:
        raise ExternalModelError("external model request timed out") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ExternalModelError("external model returned non-JSON response") from exc
    if not isinstance(parsed, dict):
        raise ExternalModelError("external model returned invalid response shape")
    return parsed


def _post_json(
    url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float
) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ExternalModelError(f"external model HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ExternalModelError(_format_url_error(exc.reason)) from exc
    except TimeoutError as exc:
        raise ExternalModelError("external model request timed out") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ExternalModelError("external model returned non-JSON response") from exc
    if not isinstance(parsed, dict):
        raise ExternalModelError("external model returned invalid response shape")
    return parsed


def _post_stream_json(
    url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float
) -> Iterator[dict[str, Any]]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if not line or line == "[DONE]":
                    break
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ExternalModelError("external model returned invalid stream JSON") from exc
                if not isinstance(parsed, dict):
                    raise ExternalModelError("external model returned invalid stream chunk")
                yield parsed
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ExternalModelError(f"external model HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ExternalModelError(_format_url_error(exc.reason)) from exc
    except TimeoutError as exc:
        raise ExternalModelError("external model request timed out") from exc


def _extract_model_ids(response: dict[str, Any]) -> list[str]:
    data = response.get("data")
    if not isinstance(data, list):
        raise ExternalModelError("external model response missing model data")
    ids: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
        elif isinstance(item, str):
            ids.append(item)
    return sorted({model_id for model_id in ids if model_id.strip()})


def _format_url_error(reason: Any) -> str:
    text = str(reason)
    if "WRONG_VERSION_NUMBER" in text.upper() or "wrong version number" in text.lower():
        return (
            "external model TLS failed: the server may be plain HTTP. "
            "Try changing the Base URL from https:// to http://."
        )
    return f"external model request failed: {text}"


def _extract_content(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ExternalModelError("external model response missing choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise ExternalModelError("external model response has invalid choice")
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        content = _normalize_model_text(message["content"]).strip()
    elif isinstance(first.get("text"), str):
        content = _normalize_model_text(first["text"]).strip()
    else:
        raise ExternalModelError("external model response missing text content")
    if not content:
        raise ExternalModelError("external model returned empty content")
    return content


def _extract_delta(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return _normalize_model_text(delta["content"])
    if isinstance(first.get("text"), str):
        return _normalize_model_text(first["text"])
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return _normalize_model_text(message["content"])
    return ""


def _extract_reasoning_content(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if isinstance(message, dict):
        for key in ("reasoning_content", "reasoning", "reasoningContent"):
            value = message.get(key)
            if isinstance(value, str):
                return _normalize_model_text(value)
    for key in ("reasoning_content", "reasoning", "reasoningContent"):
        value = first.get(key)
        if isinstance(value, str):
            return _normalize_model_text(value)
    return ""


def _extract_reasoning_delta(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        for key in ("reasoning_content", "reasoning", "reasoningContent"):
            value = delta.get(key)
            if isinstance(value, str):
                return _normalize_model_text(value)
    for key in ("reasoning_content", "reasoning", "reasoningContent"):
        value = first.get(key)
        if isinstance(value, str):
            return _normalize_model_text(value)
    return ""


def _extract_inline_reasoning_content(text: str) -> str:
    parts: list[str] = []
    for match in re.finditer(r"(?is)<(think|reasoning)\b[^>]*>(.*?)</\1>", text):
        content = match.group(2).strip()
        if content:
            parts.append(content)
    return "\n".join(parts)


def _merge_reasoning_content(existing: str, extra: str) -> str:
    existing = existing.strip()
    extra = extra.strip()
    if not extra:
        return existing
    if not existing:
        return extra
    if extra in existing:
        return existing
    return existing + "\n" + extra


def _normalize_model_text(text: str) -> str:
    if "\\u" not in text and "\\U" not in text:
        return text

    def replace_short(match: re.Match[str]) -> str:
        return chr(int(match.group(1), 16))

    def replace_long(match: re.Match[str]) -> str:
        return chr(int(match.group(1), 16))

    decoded = re.sub(r"\\u([0-9a-fA-F]{4})", replace_short, text)
    decoded = re.sub(r"\\U([0-9a-fA-F]{8})", replace_long, decoded)
    try:
        return decoded.encode("utf-16", "surrogatepass").decode("utf-16")
    except UnicodeError:
        return decoded


def _sanitize_visible_content(
    content: str,
    request: MessageRequest,
    execution: ExecutionResult,
    *,
    fallback_reply: str | None = None,
) -> _VisibleText:
    raw = _normalize_model_text(content).strip()
    text = _strip_hidden_reasoning_tags(raw).strip()

    if not text:
        return _fallback_visible_text(request, execution, raw, "empty_content", fallback_reply)

    if _looks_like_tool_json(text):
        return _fallback_visible_text(request, execution, raw, "tool_json", fallback_reply)

    if _looks_like_reasoning_dump(text) or _has_embedded_reasoning_dump(text):
        extracted = _extract_final_visible_text(text)
        if extracted and not _looks_like_tool_json(extracted) and not _looks_like_reasoning_dump(extracted):
            return _VisibleText(
                text=extracted,
                sanitized=True,
                reason="reasoning_dump",
                raw_text=raw,
            )
        return _fallback_visible_text(request, execution, raw, "reasoning_dump", fallback_reply)

    sanitized = text != raw
    return _VisibleText(
        text=text,
        sanitized=sanitized,
        reason="hidden_reasoning_tags" if sanitized else None,
        raw_text=raw,
    )


def _fallback_visible_text(
    request: MessageRequest,
    execution: ExecutionResult,
    raw: str,
    reason: str,
    fallback_reply: str | None = None,
) -> _VisibleText:
    from .renderer import Renderer

    return _VisibleText(
        text=fallback_reply if fallback_reply is not None else Renderer().render(request, execution),
        sanitized=True,
        reason=reason,
        raw_text=raw,
    )


def _strip_hidden_reasoning_tags(text: str) -> str:
    cleaned = re.sub(r"(?is)<(think|reasoning)\b[^>]*>.*?</\1>", "", text)
    cleaned = re.sub(r"(?is)^.*?</(?:think|reasoning)>", "", cleaned, count=1)
    return cleaned


def _looks_like_tool_json(text: str) -> bool:
    stripped = _strip_code_fence(text).strip()
    if not stripped:
        return False
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return False
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return '"actions"' in stripped[:500] or '"tool_calls"' in stripped[:500]
    return _contains_tool_payload(parsed)


def _contains_tool_payload(value: Any) -> bool:
    if isinstance(value, dict):
        keys = set(value)
        if keys & {"actions", "tool_calls", "toolCalls", "actionType", "function_call"}:
            return True
        return any(_contains_tool_payload(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_tool_payload(item) for item in value)
    return False


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    match = re.fullmatch(r"(?is)```(?:json)?\s*(.*?)\s*```", stripped)
    return match.group(1) if match else stripped


def _looks_like_reasoning_dump(text: str) -> bool:
    stripped = text.lstrip()
    first = stripped[:500]
    lower = first.lower()
    patterns = (
        r"^(thinking process|thought process|internal notes|reasoning process)\s*[:：]",
        r"^\d+\.\s+\*{0,2}\s*(analy[sz]e|understand|determine|formulate|drafting|refining|final review|output generation)\b",
        r"^\*+\s+\*{0,2}\s*(analy[sz]e|determine|formulate|drafting|refining)\b",
        r"^(analysis|reasoning|chain of thought)\s*[:：]",
        r"^(the user|i need to|we need to|let me|action\s*:)\b",
        r"^(分析|推理|思考|内部分析|我的思路|思考过程)\s*[:：]",
        r"^(用户说|用户表示|用户觉得|用户希望|用户要求|用户需要|用户问|用户想|用户输入|用户的请求)",
        r"^(现在是|当前是).{0,40}(可以|需要|应该).{0,80}(回复|聊|拉近|语气)",
        r"^\d+\.\s+\*{0,2}\s*(分析|理解|判断|确定|构思|草拟|润色|最终检查|输出生成)",
    )
    return any(re.search(pattern, lower if "分析" not in pattern else first, re.I) for pattern in patterns)


def _has_embedded_reasoning_dump(text: str) -> bool:
    head = text[:5000]
    patterns = (
        r"(?im)^\s*(thinking process|thought process|internal notes|reasoning process)\s*[:：]",
        r"(?im)^\s*(analysis|reasoning|chain of thought)\s*[:：]",
        r"(?m)^\s*(分析|推理|思考|内部分析|我的思路|思考过程)\s*[:：]",
        r"(?im)^\s*\d+[.)]\s+\*{0,2}\s*(analy[sz]e|understand|determine|formulate|drafting|refining|final review|output generation)\b",
        r"(?m)^\s*\d+[.)]\s+\*{0,2}\s*(分析|理解|判断|确定|构思|草拟|润色|最终检查|输出生成)",
    )
    return any(re.search(pattern, head) for pattern in patterns)


def _extract_final_visible_text(text: str) -> str:
    markers = (
        "Final Output Generation",
        "Output Generation",
        "Final Answer",
        "Final Response",
        "最终回复",
        "最终输出",
        "可见回复",
        "回复：",
    )
    candidate = ""
    for marker in markers:
        index = text.lower().rfind(marker.lower())
        if index >= 0:
            candidate = text[index + len(marker) :]
            break
    if not candidate:
        return ""

    candidate = re.sub(r"(?is)^\*+\*?.*?\)\s*", "", candidate).strip()
    lines: list[str] = []
    for line in candidate.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        cleaned = cleaned.strip("`")
        cleaned = cleaned.strip()
        if not cleaned:
            continue
        if re.match(
            r"(?i)^(critique|attempt|review|translate|tool call|action|wait|ah,|let me|this means|since)\b",
            cleaned,
        ):
            continue
        cleaned = cleaned.strip('"')
        if _contains_cjk(cleaned):
            lines.append(cleaned)
    extracted = "\n".join(lines).strip()
    extracted = extracted.strip("“”")
    return extracted if len(extracted) >= 6 else ""


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", text))


def _content_prefix_requires_full_buffer(text: str) -> bool:
    stripped = text.lstrip()
    if not stripped:
        return False
    lowered = stripped[:160].lower()
    if lowered.startswith(("<think", "<reasoning", "```json")):
        return True
    if stripped.startswith(("{", "[")):
        return True
    return _looks_like_reasoning_dump(stripped) or _has_embedded_reasoning_dump(stripped)


def _content_prefix_ready_to_stream(text: str) -> bool:
    stripped = text.lstrip()
    if not stripped:
        return False
    if _looks_like_reasoning_dump(stripped) or _has_embedded_reasoning_dump(stripped):
        return False
    return _contains_cjk(stripped) or len(stripped) >= 80


def _prompt_token_estimate(payload: dict[str, Any]) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    total = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            total += max(1, len(content) // 4)
    return total


def _prompt_layout_metrics(messages: list[dict[str, str]]) -> dict[str, Any]:
    leading_system: list[str] = []
    for message in messages:
        if message.get("role") != "system":
            break
        leading_system.append(str(message.get("content") or ""))
    stable_prefix = "\n\n".join(leading_system)
    dynamic_content = str(messages[-1].get("content") or "") if messages else ""
    return {
        "contract": "cache-friendly-v1",
        "messageRoles": [message.get("role", "") for message in messages],
        "leadingSystemCount": len(leading_system),
        "stablePrefixHash": hashlib.sha256(stable_prefix.encode("utf-8")).hexdigest(),
        "stablePrefixTokens": max(0, len(stable_prefix) // 4),
        "dynamicPromptTokens": max(0, len(dynamic_content) // 4),
        "dynamicContextRole": messages[-1].get("role") if messages else None,
    }


def _build_messages(
    storage: Storage, session_id: str, request: MessageRequest, execution: ExecutionResult
) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": _system_prompt(request.mode)}]
    semi_stable = _semi_stable_prompt(storage, request)
    if semi_stable:
        messages.append({"role": "system", "content": semi_stable})
    messages.extend(_recent_chat_messages(storage, session_id))
    messages.append(
        {
            "role": "user",
            "content": _runtime_user_prompt(storage, session_id, request, execution),
        }
    )
    return messages


def _system_prompt(mode: str) -> str:
    if mode == "sms":
        return (
            "You are the final response renderer for one continuous companion in first-person "
            "direct-message view. Reply in Chinese unless the user clearly uses another language. "
            "Speak as the character directly contacting the user, using first person naturally. "
            "Stay brief and useful while still sounding like the same person who shares everyday scenes. "
            "Return only the user-facing message. Do not expose analysis, chain-of-thought, "
            "tool calls, JSON, markdown plans, or internal action payloads. "
            "Tool actions have already been decided and executed; do not invent, cancel, "
            "or modify actions. If confirmation is required, tell the user clearly."
        )
    return (
        "You are the final response renderer for one continuous companion in third-person "
        "life-narrative view. Write Chinese scene prose by default, describing the character "
        "with third-person narration such as name/她/他, while dialogue may use first person. "
        "Reality is part of the shared everyday timeline; real-world tools have already been "
        "decided and executed. Return only the visible scene reply. Do not expose analysis, "
        "chain-of-thought, tool calls, JSON, markdown plans, or internal action payloads. "
        "Do not invent, cancel, or modify real-world actions."
    )


def _semi_stable_prompt(storage: Storage, request: MessageRequest) -> str:
    lines = [
        "Cacheable companion/session context.",
        f"mode: {request.mode}",
        "This block should contain only low-frequency profile or character information.",
        "Per-turn memory, current time, retrieval results, and tool outputs are supplied in the final user message.",
    ]
    if storage.is_enabled(FeatureName.companion_persona):
        profile = storage.get_companion_profile()
        lines.extend(
            [
                "",
                "Companion identity:",
                f"name: {profile.name}",
                f"direct_message_voice: {profile.practical_voice}",
                f"life_narrative_voice: {profile.immersive_voice}",
                f"address_style: {profile.address_style}",
            ]
        )

    if request.mode == "rp" and request.character_id:
        try:
            character = storage.get_character(request.character_id)
            lines.extend(
                [
                    "",
                    "Current RP character:",
                    f"name: {character.name}",
                    f"persona: {character.persona}",
                    f"scenario: {character.scenario}",
                    f"tags: {', '.join(character.tags)}",
                ]
            )
        except KeyError:
            lines.extend(["", f"Requested character not found: {request.character_id}"])
    return "\n".join(lines)


def _runtime_user_prompt(
    storage: Storage, session_id: str, request: MessageRequest, execution: ExecutionResult
) -> str:
    now = ensure_tz(request.now, request.timezone)
    lines = [
        "Runtime context for this turn. Use it to render the final reply, but do not quote this wrapper.",
        "This block is intentionally placed at the end of the prompt to preserve KV-cache reuse for stable prefixes.",
        f"now: {now.isoformat()}",
        f"timezone: {request.timezone}",
        "",
        "Authoritative action/result summary:",
        json.dumps(_execution_summary(execution), ensure_ascii=False, default=str),
    ]

    memory_mode = "rp" if request.mode == "rp" else "sms"
    memories = storage.recent_memories(
        mode=memory_mode,
        session_id=session_id,
        character_id=request.character_id if request.mode == "rp" else None,
        limit=6,
    )
    if memories:
        lines.extend(["", "Relevant memory:"])
        lines.extend(f"- {memory.content}" for memory in memories)

    include_real_state = _include_real_state(request)
    if (
        request.mode == "rp"
        and not include_real_state
        and storage.is_enabled(FeatureName.reality_projection)
    ):
        lines.extend(["", "Shared present (read-only, for tone/pacing only):"])
        lines.extend(_shared_present_lines(storage, now))

    if include_real_state and storage.is_enabled(FeatureName.calendar):
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        events = storage.list_events(start, start + timedelta(days=7))[:8]
        lines.extend(["", "Upcoming real-world calendar events:"])
        lines.extend(f"- {event.start.isoformat()} {event.title}" for event in events)
        if not events:
            lines.append("- none")

    if include_real_state and storage.is_enabled(FeatureName.reminders):
        reminders = storage.list_reminders()[:8]
        lines.extend(["", "Reminders:"])
        lines.extend(
            f"- {reminder.remind_at.isoformat()} {reminder.title} [{reminder.status}]"
            for reminder in reminders
        )
        if not reminders:
            lines.append("- none")
    lines.extend(["", "User message:", request.text])
    return "\n".join(lines)


def _include_real_state(request: MessageRequest) -> bool:
    return include_authoritative_real_state(request.mode, request.text)


def _shared_present_lines(storage: Storage, now) -> list[str]:
    lines = [
        "- read-only shared present; use for pacing/care, not as tool result or plot fact",
        f"- local_time={now.isoformat()}",
    ]
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    events = storage.list_events(now, day_start + timedelta(days=1))[:3]
    if events:
        lines.extend(f"- near_calendar={event.start.strftime('%H:%M')} {event.title}" for event in events)
    else:
        lines.append("- near_calendar=none")
    reminders = [
        reminder
        for reminder in storage.list_reminders()
        if reminder.status == "scheduled" and reminder.remind_at >= now
    ][:3]
    if reminders:
        lines.extend(
            f"- near_reminder={reminder.remind_at.strftime('%H:%M')} {reminder.title}"
            for reminder in reminders
        )
    else:
        lines.append("- near_reminders=none")
    open_tasks = [task for task in storage.list_tasks() if task.status in {"open", "overdue"}]
    pressure = "heavy" if len(open_tasks) >= 5 else "medium" if len(open_tasks) >= 2 else "light"
    lines.append(f"- task_pressure={pressure}; open_task_count={len(open_tasks)}")
    return lines


def _recent_chat_messages(storage: Storage, session_id: str) -> list[dict[str, str]]:
    messages = storage.recent_messages(session_id, limit=10)
    result: list[dict[str, str]] = []
    for message in messages:
        role = "assistant" if message["role"] == "assistant" else "user"
        result.append({"role": role, "content": str(message["content"])})
    return result


def _execution_summary(execution: ExecutionResult) -> dict[str, Any]:
    return {
        "actions": [
            action.model_dump(mode="json", by_alias=True) for action in execution.actions
        ],
        "confirmations": [
            confirmation.model_dump(mode="json", by_alias=True)
            for confirmation in execution.confirmations
        ],
        "artifacts": {
            key: [
                item.model_dump(mode="json", by_alias=True)
                if hasattr(item, "model_dump")
                else item
                for item in value
            ]
            if isinstance(value, list)
            else value
            for key, value in execution.artifacts.items()
        },
    }
