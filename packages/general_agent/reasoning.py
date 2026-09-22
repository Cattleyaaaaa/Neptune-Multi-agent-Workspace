import json
from dataclasses import dataclass
from typing import Protocol

import httpx


@dataclass(frozen=True, slots=True)
class ReasoningRequest:
    role: str
    objective: str
    context: str
    evidence: dict[str, object]


class ReasoningProvider(Protocol):
    name: str

    async def reason(self, request: ReasoningRequest) -> dict[str, object]: ...


class LocalStructuredReasoner:
    """Deterministic provider used until a remote model is configured."""

    name = "local-structured"

    async def reason(self, request: ReasoningRequest) -> dict[str, object]:
        evidence_names = list(request.evidence)
        return {
            "provider": self.name,
            "role": request.role,
            "objective": request.objective,
            "evidence_used": evidence_names,
            "summary": (
                f"{request.role} 已围绕目标整理结构化结果"
                + (f"，使用 {len(evidence_names)} 项证据。" if evidence_names else "。")
            ),
            "requires_external_model": False,
        }


class OpenAIResponsesReasoner:
    name = "openai-responses"

    def __init__(self, api_key: str, model: str, timeout_seconds: float = 45) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout = timeout_seconds

    async def reason(self, request: ReasoningRequest) -> dict[str, object]:
        schema = {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "findings": {"type": "array", "items": {"type": "string"}},
                "risks": {"type": "array", "items": {"type": "string"}},
                "recommendations": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["summary", "findings", "risks", "recommendations"],
            "additionalProperties": False,
        }
        payload = {
            "model": self._model,
            "store": False,
            "max_output_tokens": 900,
            "instructions": (
                f"你是通用多 Agent 系统中的{request.role}。"
                "仅依据用户目标、背景和给定证据分析；明确不确定性，不编造来源。"
            ),
            "input": json.dumps(
                {
                    "objective": request.objective,
                    "context": request.context,
                    "evidence": request.evidence,
                },
                ensure_ascii=False,
            ),
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "agent_reasoning",
                    "strict": True,
                    "schema": schema,
                }
            },
        }
        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                "https://api.openai.com/v1/responses", headers=headers, json=payload
            )
            response.raise_for_status()
        body = response.json()
        output_text = body.get("output_text") or self._extract_output_text(body)
        result = json.loads(output_text)
        result.update(
            {
                "provider": self.name,
                "model": body.get("model", self._model),
                "response_id": body.get("id"),
                "usage": body.get("usage", {}),
            }
        )
        return result

    @staticmethod
    def _extract_output_text(body: dict[str, object]) -> str:
        for item in body.get("output", []):
            if not isinstance(item, dict):
                continue
            for content in item.get("content", []):
                if isinstance(content, dict) and content.get("type") == "output_text":
                    return str(content.get("text", ""))
        raise ValueError("OpenAI response did not contain output text")


class FallbackReasoner:
    def __init__(self, primary: ReasoningProvider, fallback: ReasoningProvider) -> None:
        self.primary = primary
        self.fallback = fallback
        self.name = f"{primary.name}-with-fallback"

    async def reason(self, request: ReasoningRequest) -> dict[str, object]:
        try:
            return await self.primary.reason(request)
        except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
            result = await self.fallback.reason(request)
            result["fallback_reason"] = type(exc).__name__
            return result
