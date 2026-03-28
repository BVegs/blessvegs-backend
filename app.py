import os
import re
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


APP_NAME = "Bless Vegs Agent Backend"
APP_VERSION = "0.1.0"


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def contains_any(text: str, words: list[str]) -> bool:
    return any(word in text for word in words)


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str
    channel: str = "web"
    route: str


app = FastAPI(title=APP_NAME, version=APP_VERSION)

allowed_origins = [
    "https://bvegs.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

extra_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if extra_origin:
    allowed_origins.append(extra_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys(allowed_origins)),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


DELIVERY_TEXT = "Bezorging vanaf €5 en kan oplopen afhankelijk van de afstand."
DEFAULT_REPLY = (
    "Dank je voor je bericht. Ik help je graag verder. "
    "Voor een directe bestelling of persoonlijk contact kun je ook WhatsApp gebruiken."
)

FAQ_RULES: list[dict[str, Any]] = [
    {
        "route": "delivery",
        "keywords": ["bezorg", "bezorgen", "lever", "levering", "thuisbezorgd", "purmerend"],
        "reply": (
            f"{DELIVERY_TEXT} "
            "Wil je weten of we op jouw adres bezorgen, stuur dan je wijk of plaats mee."
        ),
    },
    {
        "route": "prices",
        "keywords": ["prijs", "prijzen", "kosten", "kost", "actie", "korting", "kortingsprijs"],
        "reply": (
            "De actuele prijzen en actieprijzen staan bij de producten op de site. "
            "Als je een specifiek product bedoelt, noem het product even."
        ),
    },
    {
        "route": "availability_amsoi",
        "keywords": ["amsoi", "groene amsoi", "rode amsoi"],
        "reply": (
            "Voor de actuele beschikbaarheid van amsoi kun je het beste even het productoverzicht bekijken "
            "of je vraag direct sturen met de naam van het product."
        ),
    },
    {
        "route": "availability_general",
        "keywords": ["beschikbaar", "voorraad", "op voorraad", "hebben jullie", "heb je"],
        "reply": (
            "De actuele voorraad hangt af van de oogst. "
            "Kijk bij de producten op de site of stuur de productnaam door voor een snelle check."
        ),
    },
    {
        "route": "ordering",
        "keywords": ["bestel", "bestellen", "order", "kopen"],
        "reply": (
            "Bestellen kan via de WhatsApp-knoppen bij de producten. "
            "Als je hulp wilt met meerdere producten tegelijk, stuur dan even je lijst door."
        ),
    },
    {
        "route": "about",
        "keywords": ["wie zijn jullie", "over bless vegs", "over jullie", "verhaal"],
        "reply": (
            "Bless Vegs is een klein en lokaal initiatief met liefde voor natuur en gezond eten. "
            "De groenten worden biologisch geteeld, zonder bestrijdingsmiddelen of chemicaliën."
        ),
    },
]


def route_message(message: str) -> tuple[str, str]:
    text = normalize_text(message)

    if not text:
      return ("Stel gerust je vraag, dan help ik je verder.", "empty")

    for rule in FAQ_RULES:
        if contains_any(text, rule["keywords"]):
            return (rule["reply"], rule["route"])

    return (DEFAULT_REPLY, "fallback")


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
    }


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "message": "Bless Vegs backend draait.",
        "health": "/health",
        "chat": "/chat",
        "whatsapp_verify": "/whatsapp/webhook",
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest) -> ChatResponse:
    reply, route = route_message(payload.message)
    return ChatResponse(reply=reply, route=route)


@app.get("/whatsapp/webhook")
async def whatsapp_verify(
    hub_mode: str | None = Query(default=None, alias="hub.mode"),
    hub_verify_token: str | None = Query(default=None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(default=None, alias="hub.challenge"),
) -> Any:
    verify_token = os.getenv("WHATSAPP_VERIFY_TOKEN", "").strip()

    if hub_mode == "subscribe" and hub_verify_token and hub_challenge:
        if verify_token and hub_verify_token == verify_token:
            return int(hub_challenge)
        raise HTTPException(status_code=403, detail="Verification failed")

    return {"status": "missing_verification_params"}


@app.post("/whatsapp/webhook")
async def whatsapp_webhook(request: Request) -> dict[str, Any]:
    """
    Basis webhook.
    Deze slaat nu alleen de payload terug als ontvangstbevestiging.
    Later koppelen we hier echte WhatsApp auto-replies aan.
    """
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc

    return {
        "received": True,
        "note": "Webhook basis ontvangen. Auto-reply logica volgt later.",
        "payload_keys": list(payload.keys()) if isinstance(payload, dict) else [],
    }
