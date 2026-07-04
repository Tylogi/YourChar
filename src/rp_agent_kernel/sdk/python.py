from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from datetime import datetime
from typing import Any

from rp_agent_kernel.kernel import Kernel
from rp_agent_kernel.models import (
    CharacterCardImportRequest,
    ConfirmationDecision,
    EvalRunRequest,
    FeatureName,
    MessageRequest,
    OpenAICompatibleConfigPatch,
)


class KernelClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8765") -> None:
        self.base_url = base_url.rstrip("/")

    def sendMessage(
        self,
        sessionId: str,
        mode: str,
        text: str,
        *,
        now: datetime | str | None = None,
        timezone: str = "Asia/Shanghai",
        characterId: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "mode": mode,
            "text": text,
            "timezone": timezone,
            "characterId": characterId,
        }
        if now is not None:
            payload["now"] = now.isoformat() if isinstance(now, datetime) else now
        return self._request("POST", f"/api/sessions/{sessionId}/messages", payload)

    def subscribeEvents(self, handler: Callable[[dict[str, Any]], None] | None = None) -> Iterator[dict[str, Any]]:
        with urllib.request.urlopen(self.base_url + "/api/events/stream") as response:
            for raw in response:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if handler:
                    handler(event)
                yield event

    def listSchedule(
        self,
        start: datetime | str | None = None,
        end: datetime | str | None = None,
    ) -> list[dict[str, Any]]:
        query: dict[str, str] = {}
        if start is not None:
            query["start"] = start.isoformat() if isinstance(start, datetime) else start
        if end is not None:
            query["end"] = end.isoformat() if isinstance(end, datetime) else end
        suffix = "?" + urllib.parse.urlencode(query) if query else ""
        return self._request("GET", "/api/calendar/events" + suffix)

    def confirmAction(self, actionId: str, decision: str) -> dict[str, Any]:
        return self._request("POST", f"/api/confirmations/{actionId}", {"decision": decision})

    def getFeatures(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/features")

    def setFeature(self, name: str, enabled: bool) -> list[dict[str, Any]]:
        return self._request("PATCH", "/api/features", {"flags": {name: enabled}})

    def getOpenAICompatibleConfig(self) -> dict[str, Any]:
        return self._request("GET", "/api/model-config/openai-compatible")

    def setOpenAICompatibleConfig(self, config: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", "/api/model-config/openai-compatible", config)

    def listOpenAICompatibleModels(self) -> dict[str, Any]:
        return self._request("GET", "/api/model-config/openai-compatible/models")

    def importCharacterCard(
        self, fileName: str, *, content: str | None = None, contentBase64: str | None = None
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/characters/import-card",
            {"fileName": fileName, "content": content, "contentBase64": contentBase64},
        )

    def runEval(self, cases: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
        payload = {"cases": cases, **options}
        return self._request("POST", "/api/eval/run", payload)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None):
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
        return json.loads(body) if body else None


class InProcessKernelClient:
    def __init__(self, kernel: Kernel | None = None) -> None:
        self.kernel = kernel or Kernel(":memory:")

    def sendMessage(
        self,
        sessionId: str,
        mode: str,
        text: str,
        *,
        now: datetime | str | None = None,
        timezone: str = "Asia/Shanghai",
        characterId: str | None = None,
    ) -> dict[str, Any]:
        request = MessageRequest(
            mode=mode,
            text=text,
            now=now,
            timezone=timezone,
            characterId=characterId,
        )
        response = self.kernel.handle_message(sessionId, request)
        return response.model_dump(mode="json", by_alias=True)

    def listSchedule(
        self,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[dict[str, Any]]:
        return [
            event.model_dump(mode="json", by_alias=True)
            for event in self.kernel.storage.list_events(start, end)
        ]

    def confirmAction(self, actionId: str, decision: str) -> dict[str, Any]:
        response = self.kernel.confirm_action(actionId, ConfirmationDecision(decision=decision))
        return response.model_dump(mode="json", by_alias=True)

    def getFeatures(self) -> list[dict[str, Any]]:
        return [
            feature.model_dump(mode="json", by_alias=True)
            for feature in self.kernel.storage.feature_records()
        ]

    def setFeature(self, name: str, enabled: bool) -> list[dict[str, Any]]:
        features = self.kernel.storage.set_features({FeatureName(name): enabled})
        return [feature.model_dump(mode="json", by_alias=True) for feature in features]

    def getOpenAICompatibleConfig(self) -> dict[str, Any]:
        return self.kernel.storage.get_openai_config().model_dump(mode="json", by_alias=True)

    def setOpenAICompatibleConfig(self, config: dict[str, Any]) -> dict[str, Any]:
        response = self.kernel.storage.patch_openai_config(
            OpenAICompatibleConfigPatch.model_validate(config)
        )
        return response.model_dump(mode="json", by_alias=True)

    def listOpenAICompatibleModels(self) -> dict[str, Any]:
        models = self.kernel.external_model.list_models(
            config=self.kernel.storage.get_raw_openai_config()
        )
        return {"models": models, "count": len(models)}

    def importCharacterCard(
        self, fileName: str, *, content: str | None = None, contentBase64: str | None = None
    ) -> dict[str, Any]:
        from rp_agent_kernel.character_cards import parse_character_card

        request = CharacterCardImportRequest(
            fileName=fileName, content=content, contentBase64=contentBase64
        )
        character_create, parsed_format, warnings = parse_character_card(
            file_name=request.file_name,
            content=request.content,
            content_base64=request.content_base64,
        )
        character = self.kernel.storage.create_character(character_create)
        return {
            "parsedFormat": parsed_format,
            "character": character.model_dump(mode="json", by_alias=True),
            "warnings": warnings,
        }

    def runEval(self, cases: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
        response = self.kernel.run_eval(EvalRunRequest.model_validate({"cases": cases, **options}))
        return response.model_dump(mode="json", by_alias=True)
