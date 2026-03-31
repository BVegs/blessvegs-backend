import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FRONTEND_URL = process.env.FRONTEND_URL;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "";

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
  process.exit(1);
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET");
  process.exit(1);
}
if (!ADMIN_USERNAME) {
  console.error("Missing ADMIN_USERNAME");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("Missing ADMIN_PASSWORD");
  process.exit(1);
}

const allowedOrigins = [
  FRONTEND_URL,
  ...ALLOWED_ORIGINS.split(",").map(v => v.trim())
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function createToken() {
  return jwt.sign(
    { role: "admin", username: ADMIN_USERNAME },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function getTokenFromHeader(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

function authRequired(req, res, next) {
  try {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Niet ingelogd" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Geen toegang" });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Ongeldige of verlopen sessie" });
  }
}

function normalizeProductPayload(body = {}) {
  return {
    name: body.name?.toString().trim() || "",
    prijs: body.prijs === "" || body.prijs == null ? null : Number(body.prijs),
    kortingsprijs:
      body.kortingsprijs === "" || body.kortingsprijs == null
        ? null
        : Number(body.kortingsprijs),
    voorraad: body.voorraad === "" || body.voorraad == null ? null : Number(body.voorraad),
    voorraad_type: body.voorraad_type?.toString().trim() || "stuk",
    foto: body.foto?.toString().trim() || null,
    afbeelding: body.afbeelding?.toString().trim() || null,
    beschrijving: body.beschrijving?.toString().trim() || null,
  };
}

function validateProductPayload(payload) {
  if (!payload.name) return "Productnaam is verplicht";
  if (payload.prijs == null || Number.isNaN(payload.prijs)) return "Prijs is verplicht";
  if (payload.voorraad == null || Number.isNaN(payload.voorraad)) return "Voorraad is verplicht";
  if (!payload.voorraad_type) return "Voorraad type is verplicht";
  return null;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Bless Vegs backend" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Bless Vegs backend",
    time: new Date().toISOString(),
  });
});

app.post("/admin/login", async (req, res) => {
  try {
    const username = req.body?.username?.toString().trim() || "";
    const password = req.body?.password?.toString() || "";

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Gebruikersnaam en wachtwoord zijn verplicht",
      });
    }

    if (username !== ADMIN_USERNAME) {
      return res.status(401).json({ ok: false, error: "Onjuiste login" });
    }

    let validPassword = false;

    if (
      ADMIN_PASSWORD.startsWith("$2a$") ||
      ADMIN_PASSWORD.startsWith("$2b$") ||
      ADMIN_PASSWORD.startsWith("$2y$")
    ) {
      validPassword = await bcrypt.compare(password, ADMIN_PASSWORD);
    } else {
      validPassword = password === ADMIN_PASSWORD;
    }

    if (!validPassword) {
      return res.status(401).json({ ok: false, error: "Onjuiste login" });
    }

    const token = createToken();

    res.json({
      ok: true,
      token,
      user: {
        username: ADMIN_USERNAME,
        role: "admin",
      },
    });
  } catch (error) {
    console.error("POST /admin/login error:", error);
    res.status(500).json({ ok: false, error: "Serverfout bij inloggen" });
  }
});

app.get("/admin/me", authRequired, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get("/admin/products", authRequired, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("producten")
      .select("*")
      .order("id", { ascending: false });

    if (error) throw error;

    res.json({ ok: true, data: data || [] });
  } catch (error) {
    console.error("GET /admin/products error:", error);
    res.status(500).json({ ok: false, error: "Kon producten niet ophalen" });
  }
});

app.post("/admin/products", authRequired, async (req, res) => {
  try {
    const payload = normalizeProductPayload(req.body);
    const validationError = validateProductPayload(payload);

    if (validationError) {
      return res.status(400).json({ ok: false, error: validationError });
    }

    const { data, error } = await supabase
      .from("producten")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ ok: true, data });
  } catch (error) {
    console.error("POST /admin/products error:", error);
    res.status(500).json({ ok: false, error: "Kon product niet toevoegen" });
  }
});

app.put("/admin/products/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const payload = normalizeProductPayload(req.body);
    const validationError = validateProductPayload(payload);

    if (validationError) {
      return res.status(400).json({ ok: false, error: validationError });
    }

    const { data, error } = await supabase
      .from("producten")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, data });
  } catch (error) {
    console.error("PUT /admin/products/:id error:", error);
    res.status(500).json({ ok: false, error: "Kon product niet opslaan" });
  }
});

app.delete("/admin/products/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;

    const { error } = await supabase
      .from("producten")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE /admin/products/:id error:", error);
    res.status(500).json({ ok: false, error: "Kon product niet verwijderen" });
  }
});

app.get("/admin/orders", authRequired, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ ok: true, data: data || [] });
  } catch (error) {
    console.error("GET /admin/orders error:", error);
    res.status(500).json({ ok: false, error: "Kon orders niet ophalen" });
  }
});

app.put("/admin/orders/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const status = req.body?.status?.toString().trim();

    if (!status) {
      return res.status(400).json({ ok: false, error: "Status is verplicht" });
    }

    const { data, error } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, data });
  } catch (error) {
    console.error("PUT /admin/orders/:id error:", error);
    res.status(500).json({ ok: false, error: "Kon orderstatus niet opslaan" });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Route niet gevonden" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bless Vegs backend running on port ${PORT}`);
});
