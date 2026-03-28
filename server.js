const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://bvegs.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "null"
];

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS: origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function buildSafeEventBody(body = {}) {
  return {
    type: cleanString(body.type, 80),
    source: cleanString(body.source, 80),
    productName: cleanString(body.productName, 160),
    question: cleanString(body.question, 500),
    price: cleanNumber(body.price),
    stock: cleanString(body.stock, 120),
    page: cleanString(body.page, 200),
    userAgent: cleanString(body.userAgent, 300)
  };
}

function logEvent(label, req, payload) {
  const entry = {
    time: nowIso(),
    label,
    ip: getClientIp(req),
    origin: req.headers.origin || "",
    method: req.method,
    path: req.originalUrl,
    payload
  };

  console.log(JSON.stringify(entry));
}

app.get("/", (req, res) => {
  res.status(200).send("BlessVegs backend draait 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "blessvegs-backend",
    env: NODE_ENV,
    time: nowIso()
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "blessvegs-backend",
    env: NODE_ENV,
    time: nowIso()
  });
});

app.post("/order", (req, res) => {
  const payload = buildSafeEventBody(req.body);

  if (!payload.type) {
    payload.type = "order_event";
  }

  logEvent("order", req, payload);

  return res.status(200).json({
    success: true,
    message: "Bestelling of actie ontvangen.",
    receivedAt: nowIso()
  });
});

app.post("/contact", (req, res) => {
  const payload = buildSafeEventBody(req.body);

  if (!payload.question && !payload.productName) {
    return res.status(400).json({
      success: false,
      message: "Vraag of productinformatie ontbreekt."
    });
  }

  if (!payload.type) {
    payload.type = "contact_event";
  }

  logEvent("contact", req, payload);

  return res.status(200).json({
    success: true,
    message: "Contactaanvraag ontvangen.",
    receivedAt: nowIso()
  });
});

app.post("/events", (req, res) => {
  const payload = buildSafeEventBody(req.body);

  if (!payload.type) {
    return res.status(400).json({
      success: false,
      message: "Event type ontbreekt."
    });
  }

  logEvent("event", req, payload);

  return res.status(200).json({
    success: true,
    message: "Event ontvangen.",
    receivedAt: nowIso()
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint niet gevonden."
  });
});

app.use((err, req, res, next) => {
  const message = err && err.message ? err.message : "Onbekende serverfout";

  console.error(JSON.stringify({
    time: nowIso(),
    label: "server_error",
    method: req.method,
    path: req.originalUrl,
    ip: getClientIp(req),
    error: message
  }));

  if (message.toLowerCase().includes("cors")) {
    return res.status(403).json({
      success: false,
      message: "Toegang geweigerd door CORS."
    });
  }

  return res.status(500).json({
    success: false,
    message: "Interne serverfout."
  });
});

app.listen(PORT, () => {
  console.log(`BlessVegs backend running on port ${PORT} (${NODE_ENV})`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
});
