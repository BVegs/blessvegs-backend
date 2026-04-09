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
  ...ALLOWED_ORIGINS.split(",").map((v) => v.trim())
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  })
);

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
  } catch {
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
    beschrijving: body.beschrijving?.toString().trim() || null
  };
}

function validateProductPayload(payload) {
  if (!payload.name) return "Productnaam is verplicht";
  if (payload.prijs == null || Number.isNaN(payload.prijs)) return "Prijs is verplicht";
  if (payload.voorraad == null || Number.isNaN(payload.voorraad)) return "Voorraad is verplicht";
  if (!payload.voorraad_type) return "Voorraad type is verplicht";
  return null;
}

function getEffectivePrice(product) {
  const prijs = Number(product.prijs || 0);
  const korting = Number(product.kortingsprijs || 0);
  if (korting > 0 && korting < prijs) return korting;
  return prijs;
}

function normalizePhone(phone = "") {
  return String(phone).replace(/[^\d+]/g, "").trim();
}

function calcDeliveryFee(orderType, subtotal) {
  if (orderType === "ophalen") return 0;
  if (subtotal >= 50) return 5;
  return 5;
}

function parseRequestedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      product_id: Number(item.product_id),
      qty: Number(item.qty || 0)
    }))
    .filter((item) => Number.isFinite(item.product_id) && item.qty > 0);
}

async function getProductsByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("producten")
    .select("*")
    .in("id", ids);

  if (error) throw error;
  return data || [];
}

function buildOrderSummaryLines(selectedItems, productsMap) {
  const lines = [];
  let subtotal = 0;

  for (const item of selectedItems) {
    const product = productsMap.get(item.product_id);
    if (!product) continue;

    const unitPrice = getEffectivePrice(product);
    const lineTotal = unitPrice * item.qty;
    subtotal += lineTotal;

    lines.push({
      product_id: product.id,
      name: product.name,
      qty: item.qty,
      unit: product.voorraad_type || "stuk",
      unit_price: unitPrice,
      line_total: lineTotal
    });
  }

  return { lines, subtotal };
}

function toOrderText(lines) {
  return lines
    .map(
      (line) =>
        `${line.name} x${line.qty} (${line.unit}) - €${line.line_total.toFixed(2)}`
    )
    .join(" | ");
}

function buildWhatsAppMessage(orderRecord, lineItems, deliveryFee) {
  const linesText = lineItems
    .map(
      (line) =>
        `- ${line.name} x${line.qty} (${line.unit}) = €${line.line_total.toFixed(2)}`
    )
    .join("\n");

  return [
    `Hallo Bless Vegs, ik heb zojuist een bestelling geplaatst.`,
    ``,
    `Ordernummer: ${orderRecord.id}`,
    `Naam: ${orderRecord.naam || "-"}`,
    `Telefoon: ${orderRecord.telefoon || "-"}`,
    `Levering: ${orderRecord.levering || "-"}`,
    `Adres: ${orderRecord.adres || "-"}`,
    ``,
    `Producten:`,
    linesText,
    ``,
    `Bezorgkosten: €${deliveryFee.toFixed(2)}`,
    `Totaal: €${Number(orderRecord.totaal || 0).toFixed(2)}`,
    ``,
    `Kunt u mijn bestelling bevestigen?`
  ].join("\n");
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Bless Vegs backend" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Bless Vegs backend",
    time: new Date().toISOString()
  });
});

app.post("/admin/login", async (req, res) => {
  try {
    const username = req.body?.username?.toString().trim() || "";
    const password = req.body?.password?.toString() || "";

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Gebruikersnaam en wachtwoord zijn verplicht"
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
        role: "admin"
      }
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
    const { error } = await supabase.from("producten").delete().eq("id", id);

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

app.get("/public/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("producten")
      .select("*")
      .order("id", { ascending: false });

    if (error) throw error;

    const visible = (data || []).filter((p) => Number(p.voorraad || 0) > 0);

    res.json({ ok: true, data: visible });
  } catch (error) {
    console.error("GET /public/products error:", error);
    res.status(500).json({ ok: false, error: "Kon producten niet laden" });
  }
});

app.get("/public/settings", (req, res) => {
  res.json({
    ok: true,
    data: {
      whatsapp_phone: "31685122481",
      delivery_note: "Bezorging vanaf €5 en kan oplopen afhankelijk van de afstand.",
      pickup_note: "Ophalen kan ook, locatie wisselt per dag en ontvang je na bestelling.",
      package_options: [
        { label: "Groentepakket €15", amount: 15 },
        { label: "Groentepakket €25", amount: 25 }
      ]
    }
  });
});

app.post("/public/order-quote", async (req, res) => {
  try {
    const items = parseRequestedItems(req.body?.items);
    const orderType = req.body?.levering === "ophalen" ? "ophalen" : "bezorgen";

    if (!items.length) {
      return res.status(400).json({ ok: false, error: "Geen geldige producten gekozen" });
    }

    const products = await getProductsByIds(items.map((i) => i.product_id));
    const productsMap = new Map(products.map((p) => [Number(p.id), p]));
    const { lines, subtotal } = buildOrderSummaryLines(items, productsMap);

    if (!lines.length) {
      return res.status(400).json({ ok: false, error: "Geen geldige producten gevonden" });
    }

    const deliveryFee = calcDeliveryFee(orderType, subtotal);
    const total = subtotal + deliveryFee;

    res.json({
      ok: true,
      data: {
        items: lines,
        subtotal,
        delivery_fee: deliveryFee,
        total,
        levering: orderType
      }
    });
  } catch (error) {
    console.error("POST /public/order-quote error:", error);
    res.status(500).json({ ok: false, error: "Kon prijsberekening niet maken" });
  }
});

app.post("/public/orders", async (req, res) => {
  try {
    const naam = req.body?.naam?.toString().trim() || "";
    const telefoon = normalizePhone(req.body?.telefoon || "");
    const adres = req.body?.adres?.toString().trim() || "";
    const levering = req.body?.levering === "ophalen" ? "ophalen" : "bezorgen";
    const items = parseRequestedItems(req.body?.items);

    if (!naam) {
      return res.status(400).json({ ok: false, error: "Naam is verplicht" });
    }
    if (!telefoon) {
      return res.status(400).json({ ok: false, error: "Telefoon is verplicht" });
    }
    if (levering === "bezorgen" && !adres) {
      return res.status(400).json({ ok: false, error: "Adres is verplicht bij bezorgen" });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "Kies minimaal 1 product" });
    }

    const products = await getProductsByIds(items.map((i) => i.product_id));
    const productsMap = new Map(products.map((p) => [Number(p.id), p]));
    const { lines, subtotal } = buildOrderSummaryLines(items, productsMap);

    if (!lines.length) {
      return res.status(400).json({ ok: false, error: "Geen geldige producten gevonden" });
    }

    const deliveryFee = calcDeliveryFee(levering, subtotal);
    const total = subtotal + deliveryFee;

    let customerId = null;

    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("*")
      .eq("telefoon", telefoon)
      .maybeSingle();

    if (existingCustomer?.id) {
      customerId = existingCustomer.id;

      await supabase
        .from("customers")
        .update({ naam, adres })
        .eq("id", customerId);
    } else {
      const { data: newCustomer, error: customerInsertError } = await supabase
        .from("customers")
        .insert([{ naam, telefoon, adres }])
        .select()
        .single();

      if (customerInsertError) throw customerInsertError;
      customerId = newCustomer.id;
    }

    const orderPayload = {
      customer_id: customerId,
      naam,
      telefoon,
      adres: levering === "ophalen" ? "" : adres,
      levering,
      producten: toOrderText(lines),
      totaal: total,
      status: "nieuw"
    };

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([orderPayload])
      .select()
      .single();

    if (orderError) throw orderError;

    const whatsappMessage = buildWhatsAppMessage(order, lines, deliveryFee);

    res.status(201).json({
      ok: true,
      data: {
        order,
        items: lines,
        subtotal,
        delivery_fee: deliveryFee,
        total,
        whatsapp_message: whatsappMessage,
        whatsapp_url: `https://wa.me/31685122481?text=${encodeURIComponent(whatsappMessage)}`
      }
    });
  } catch (error) {
    console.error("POST /public/orders error:", error);
    res.status(500).json({ ok: false, error: "Kon bestelling niet opslaan" });
  }
});

app.post("/public/agent/intake", async (req, res) => {
  try {
    const message = req.body?.message?.toString().trim() || "";

    if (!message) {
      return res.status(400).json({ ok: false, error: "Bericht is verplicht" });
    }

    const lower = message.toLowerCase();

    const intent =
      lower.includes("bezorgen") || lower.includes("ophalen")
        ? "delivery_question"
        : lower.includes("bestel") || lower.includes("wil")
          ? "order_intent"
          : lower.includes("prijs") || lower.includes("kost")
            ? "pricing_question"
            : "general_question";

    const { data: products } = await supabase
      .from("producten")
      .select("id,name,prijs,kortingsprijs,voorraad,voorraad_type")
      .order("id", { ascending: false });

    const matchedProducts = (products || []).filter((p) =>
      lower.includes(String(p.name || "").toLowerCase())
    );

    res.json({
      ok: true,
      data: {
        intent,
        original_message: message,
        matched_products: matchedProducts,
        next_action:
          intent === "order_intent"
            ? "collect_customer_details"
            : intent === "delivery_question"
              ? "reply_with_delivery_options"
              : intent === "pricing_question"
                ? "reply_with_price_info"
                : "ask_clarifying_question"
      }
    });
  } catch (error) {
    console.error("POST /public/agent/intake error:", error);
    res.status(500).json({ ok: false, error: "Kon intake niet verwerken" });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Route niet gevonden" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bless Vegs backend running on port ${PORT}`);
});
