BLESS VEGS RENDER BASIS

1. Zet deze bestanden in een nieuwe GitHub repo:
   - app.py
   - requirements.txt
   - render.yaml
   - .env.example

2. Ga naar Render
   - New +
   - Blueprint of Web Service
   - koppel je GitHub repo

3. Render gebruikt:
   - buildCommand: pip install -r requirements.txt
   - startCommand: uvicorn app:app --host 0.0.0.0 --port $PORT

4. Na deploy test je:
   /health
   /chat

5. Voorbeeld POST naar /chat:
   {
     "message": "Wat kost bezorging?"
   }

6. In je site zet je later de Render URL in:
   APP_CONFIG.agentApiUrl = "https://jouw-render-url.onrender.com"

7. De WhatsApp webhook route staat al klaar:
   GET  /whatsapp/webhook
   POST /whatsapp/webhook

De echte WhatsApp auto-reply en OpenAI-logica bouwen we hier later bovenop.
