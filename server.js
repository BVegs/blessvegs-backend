const express = require('express');
const cors = require('cors');
const https = require('https');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://bvegs.github.io';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-5.4';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('Ontbrekende environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

function sendSuccess(res, message, data = null, status = 200) {
  return res.status(status).json({
    ok: true,
    message,
    data
  });
}

function sendError(res, status, error, details = null) {
  return res.status(status).json({
    ok: false,
    error,
    details
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function getEffectivePrice(product) {
  const normal = toNumber(product.basis_prijs ?? product.prijs, 0);
  const sale = toNumber(product.kortingsprijs, 0);
  return sale > 0 && sale < normal ? sale : normal;
}

function unitToGrams(amount, unit) {
  const numeric = toNumber(amount, 0);
  if (unit === 'kg') return numeric * 1000;
  if (unit === 'g') return numeric;
  return numeric;
}

function gramsToDisplayLabel(grams) {
  if (grams >= 1000 && grams % 1000 === 0) {
    return `${grams / 1000} kg`;
  }
  return `${grams} g`;
}

function quantityLabel(amount, unit) {
  const value = toNumber(amount, 0);
  if (unit === 'g') return gramsToDisplayLabel(value);
  return `${value} ${unit}`;
}

function normalizeProductRecord(row) {
  const verkoop_type = row.verkoop_type || 'stuk';
  const basis_prijs = toNumber(row.basis_prijs ?? row.prijs, 0);
  const kortingsprijs = toNumber(row.kortingsprijs, 0);
  const basis_eenheid = row.basis_eenheid || row.voorraad_type || 'stuk';
  const referentie_eenheid = row.referentie_eenheid || (verkoop_type === 'gewicht' ? 'kg' : basis_eenheid);
  const minimum_bestelhoeveelheid = toNumber(row.minimum_bestelhoeveelheid, verkoop_type === 'gewicht' ? 250 : 1);
  const stapgrootte = toNumber(row.stapgrootte, verkoop_type === 'gewicht' ? 250 : 1);
  const maximum_bestelhoeveelheid = row.maximum_bestelhoeveelheid == null ? null : toNumber(row.maximum_bestelhoeveelheid, null);
  const voorraad_aantal = toNumber(row.voorraad_aantal ?? row.voorraad, 0);
  const voorraad_eenheid = row.voorraad_eenheid || row.voorraad_type || basis_eenheid;
  const actief = row.actief !== false;
  const beschrijving = row.beschrijving || row.omschrijving || '';
  const foto = row.foto || row.afbeelding || '';

  return {
    ...row,
    actief,
    verkoop_type,
    basis_prijs,
    basis_eenheid,
    referentie_eenheid,
    minimum_bestelhoeveelheid,
    stapgrootte,
    maximum_bestelhoeveelheid,
    voorraad_aantal,
    voorraad_eenheid,
    kortingsprijs,
    beschrijving,
    foto,
    slug: slugify(row.name),
    prijs: toNumber(row.prijs ?? row.basis_prijs, 0),
    voorraad: toNumber(row.voorraad ?? row.voorraad_aantal, 0),
    voorraad_type: row.voorraad_type || row.voorraad_eenheid || basis_eenheid
  };
}

function buildWeightOptions(product) {
  const effectivePrice = getEffectivePrice(product);
  const baseUnit = product.basis_eenheid;
  const voorraadInGrams = unitToGrams(product.voorraad_aantal, product.voorraad_eenheid);
  const minInGrams = unitToGrams(product.minimum_bestelhoeveelheid, baseUnit);
  const stepInGrams = unitToGrams(product.stapgrootte, baseUnit);
  const maxConfiguredInGrams = product.maximum_bestelhoeveelheid == null
    ? voorraadInGrams
    : unitToGrams(product.maximum_bestelhoeveelheid, baseUnit);
  const hardMaxInGrams = Math.min(maxConfiguredInGrams, voorraadInGrams);

  if (minInGrams <= 0 || stepInGrams <= 0 || hardMaxInGrams < minInGrams) {
    return [];
  }

  const pricePerGram = baseUnit === 'kg'
    ? effectivePrice / 1000
    : baseUnit === 'g'
      ? effectivePrice
      : 0;

  const options = [];
  for (let grams = minInGrams; grams <= hardMaxInGrams; grams += stepInGrams) {
    options.push({
      hoeveelheid: grams,
      eenheid: 'g',
      prijs: round2(pricePerGram * grams),
      label: gramsToDisplayLabel(grams)
    });
  }
  return options;
}

function buildFixedOptions(product) {
  const effectivePrice = getEffectivePrice(product);
  const qty = toNumber(product.minimum_bestelhoeveelheid, 1);
  const unit = product.basis_eenheid;
  return [{
    hoeveelheid: qty,
    eenheid: unit,
    prijs: round2(effectivePrice * qty),
    label: quantityLabel(qty, unit)
  }];
}

function enrichProduct(product) {
  const effectivePrice = getEffectivePrice(product);
  const bestelopties = product.verkoop_type === 'gewicht'
    ? buildWeightOptions(product)
    : buildFixedOptions(product);

  let display_prijs = effectivePrice;
  let display_prijs_label = `${new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(effectivePrice)} per ${product.basis_eenheid}`;
  let display_referentieprijs_label = null;

  if (product.verkoop_type === 'gewicht') {
    const firstOption = bestelopties[0] || null;
    if (firstOption) {
      display_prijs = firstOption.prijs;
      display_prijs_label = `vanaf ${new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(firstOption.prijs)} per ${firstOption.label}`;
    }

    const refPrice = product.referentie_eenheid === '100g'
      ? round2((product.basis_eenheid === 'kg' ? effectivePrice / 10 : effectivePrice * 100))
      : product.basis_eenheid === 'g'
        ? round2(effectivePrice * 1000)
        : round2(effectivePrice);

    const refUnit = product.referentie_eenheid || 'kg';
    display_referentieprijs_label = `${new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(refPrice)} per ${refUnit}`;
  }

  return {
    ...product,
    display_prijs,
    display_prijs_label,
    display_referentieprijs_label,
    bestelopties
  };
}

function validateProductInput(input) {
  const errors = [];

  const verkoop_type = input.verkoop_type || 'stuk';
  const basis_prijs = toNumber(input.basis_prijs ?? input.prijs, NaN);
  const kortingsprijs = input.kortingsprijs === '' || input.kortingsprijs == null ? 0 : toNumber(input.kortingsprijs, NaN);
  const basis_eenheid = input.basis_eenheid || input.voorraad_type || 'stuk';
  const minimum = toNumber(input.minimum_bestelhoeveelheid, verkoop_type === 'gewicht' ? 250 : 1);
  const stap = toNumber(input.stapgrootte, verkoop_type === 'gewicht' ? 250 : 1);
  const maximum = input.maximum_bestelhoeveelheid === '' || input.maximum_bestelhoeveelheid == null
    ? null
    : toNumber(input.maximum_bestelhoeveelheid, NaN);
  const voorraad_aantal = toNumber(input.voorraad_aantal ?? input.voorraad, NaN);
  const voorraad_eenheid = input.voorraad_eenheid || input.voorraad_type || basis_eenheid;

  if (!String(input.name || '').trim()) errors.push('Productnaam is verplicht.');
  if (!['stuk', 'bos', 'bakje', 'gewicht'].includes(verkoop_type)) errors.push('Ongeldig verkoop_type.');
  if (!['stuk', 'bos', 'bakje', 'kg', 'g'].includes(basis_eenheid)) errors.push('Ongeldige basis_eenheid.');
  if (!['stuk', 'bos', 'bakje', 'kg', 'g'].includes(voorraad_eenheid)) errors.push('Ongeldige voorraad_eenheid.');
  if (!Number.isFinite(basis_prijs) || basis_prijs < 0) errors.push('Basisprijs is ongeldig.');
  if (!Number.isFinite(voorraad_aantal) || voorraad_aantal < 0) errors.push('Voorraad is ongeldig.');
  if (!Number.isFinite(minimum) || minimum <= 0) errors.push('Minimum bestelhoeveelheid is ongeldig.');
  if (!Number.isFinite(stap) || stap <= 0) errors.push('Stapgrootte is ongeldig.');
  if (maximum !== null && (!Number.isFinite(maximum) || maximum <= 0)) errors.push('Maximum bestelhoeveelheid is ongeldig.');
  if (Number.isFinite(kortingsprijs) && kortingsprijs > 0 && kortingsprijs >= basis_prijs) errors.push('Kortingsprijs moet lager zijn dan basisprijs.');

  if (verkoop_type === 'gewicht') {
    if (!['kg', 'g'].includes(basis_eenheid)) errors.push('Gewicht-product moet basis_eenheid kg of g hebben.');
    if (!['kg', 'g'].includes(voorraad_eenheid)) errors.push('Gewicht-product moet voorraad_eenheid kg of g hebben.');
  } else {
    if (!['stuk', 'bos', 'bakje'].includes(basis_eenheid)) errors.push('Niet-gewicht product moet basis_eenheid stuk, bos of bakje hebben.');
    if (minimum !== 1) errors.push('Voor stuk/bos/bakje moet minimum_bestelhoeveelheid 1 zijn.');
    if (stap !== 1) errors.push('Voor stuk/bos/bakje moet stapgrootte 1 zijn.');
    if (voorraad_eenheid !== basis_eenheid) errors.push('Voorraad_eenheid moet gelijk zijn aan basis_eenheid bij stuk/bos/bakje.');
  }

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.statusCode = 400;
    throw error;
  }
}

function validateReviewInput(input) {
  const name = String(input.name || '').trim();
  const message = String(input.message || '').trim();

  if (!message) {
    const error = new Error('Bericht is verplicht.');
    error.statusCode = 400;
    throw error;
  }

  if (message.length > 180) {
    const error = new Error('Bericht mag maximaal 180 tekens zijn.');
    error.statusCode = 400;
    throw error;
  }

  if (name.length > 60) {
    const error = new Error('Naam mag maximaal 60 tekens zijn.');
    error.statusCode = 400;
    throw error;
  }

  return {
    name: name || 'Klant',
    message
  };
}

function validateAssistantInput(input) {
  const message = String(input.message || '').trim();

  if (!message) {
    const error = new Error('Vraag is verplicht.');
    error.statusCode = 400;
    throw error;
  }

  if (message.length > 800) {
    const error = new Error('Vraag is te lang. Houd het onder 800 tekens.');
    error.statusCode = 400;
    throw error;
  }

  return { message };
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return sendError(res, 401, 'Je bent niet ingelogd.');
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return sendError(res, 401, 'Je sessie is verlopen. Log opnieuw in.');
  }
}

function buildProductSummary(products) {
  if (!products.length) {
    return 'Er zijn momenteel geen actieve producten zichtbaar.';
  }

  return products.slice(0, 30).map((product) => {
    const name = product.name || 'Onbekend product';
    const price = product.display_prijs_label || 'prijs onbekend';
    const ref = product.display_referentieprijs_label ? ` (${product.display_referentieprijs_label})` : '';
    const desc = product.beschrijving ? ` - ${product.beschrijving}` : '';
    return `- ${name}: ${price}${ref}${desc}`;
  }).join('\n');
}

function extractResponseText(json) {
  if (!json || typeof json !== 'object') return '';

  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text.trim();
  }

  const output = Array.isArray(json.output) ? json.output : [];
  const parts = [];

  for (const item of output) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content && typeof content.text === 'string') {
          parts.push(content.text);
        }
      }
    }
  }

  return parts.join('\n').trim();
}

function createOpenAIResponse(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/responses',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        }
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          let parsed = null;

          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (parseError) {
            return reject(new Error('OpenAI gaf geen geldige JSON terug.'));
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const apiMessage =
              parsed?.error?.message ||
              parsed?.message ||
              `OpenAI request mislukt met status ${res.statusCode}`;
            return reject(new Error(apiMessage));
          }

          resolve(parsed);
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function askBlessVegsAssistant(userMessage) {
  const { data, error } = await supabase
    .from('producten')
    .select('*')
    .eq('actief', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: false });

  if (error) {
    throw new Error('Actuele producten konden niet worden geladen voor de assistent.');
  }

  const products = (data || [])
    .map(normalizeProductRecord)
    .map(enrichProduct);

  const productSummary = buildProductSummary(products);

  const developerPrompt = [
    'Je bent de Bless Vegs assistent.',
    'Je helpt alleen met vragen over Bless Vegs.',
    'Beantwoord in het Nederlands.',
    'Wees vriendelijk, duidelijk en kort.',
    'Je mag helpen met producten, beschikbaarheid, prijsuitleg, bezorgen, flex pickup, pop-up locatie, bestellen via WhatsApp en contact.',
    'Verzin geen producten, prijzen of beleid dat niet in de context staat.',
    'Als iets niet zeker is, zeg dat eerlijk en verwijs naar WhatsApp of e-mail voor bevestiging.',
    'Als de vraag buiten Bless Vegs valt, zeg dan dat je alleen helpt met Bless Vegs vragen.',
    '',
    'Vaste informatie:',
    '- Bestellen gaat vooral via WhatsApp.',
    '- WhatsApp nummer: 31685122481',
    '- E-mail: info@blessvegs.nl',
    '- Bezorging vanaf €5 en kan oplopen afhankelijk van de afstand.',
    '- Flex pickup: locatie en tijd volgen na bestelling via WhatsApp.',
    '- Pop-up locatie: op bepaalde dagen mogelijk, dit wordt via WhatsApp gedeeld.',
    '',
    'Actuele producten:',
    productSummary
  ].join('\n');

  const response = await createOpenAIResponse({
    model: AI_MODEL,
    input: [
      {
        role: 'developer',
        content: developerPrompt
      },
      {
        role: 'user',
        content: userMessage
      }
    ],
    max_output_tokens: 350
  });

  const answer = extractResponseText(response);

  if (!answer) {
    throw new Error('De assistent gaf geen bruikbaar antwoord terug.');
  }

  return answer;
}

app.get('/health', (_req, res) => {
  return sendSuccess(res, 'Bless Vegs backend live.', {
    service: 'Bless Vegs backend',
    time: new Date().toISOString(),
    ai_enabled: Boolean(OPENAI_API_KEY)
  });
});

app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return sendError(res, 400, 'Vul gebruikersnaam en wachtwoord in.');
    }

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return sendError(res, 401, 'Onjuiste gebruikersnaam of wachtwoord.');
    }

    const token = jwt.sign(
      { username: ADMIN_USERNAME, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    return sendSuccess(res, 'Login gelukt.', { token });
  } catch (error) {
    console.error('Login route error:', error);
    return sendError(res, 500, 'Er ging iets mis tijdens het inloggen.');
  }
});

app.get('/public/products', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('producten')
      .select('*')
      .eq('actief', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: false });

    if (error) {
      console.error('Supabase public products error:', error);
      return sendError(res, 500, 'Producten konden niet geladen worden.');
    }

    const products = (data || [])
      .map(normalizeProductRecord)
      .map(enrichProduct);

    return sendSuccess(res, 'Publieke producten geladen.', products);
  } catch (error) {
    console.error('Public products route error:', error);
    return sendError(res, 500, 'Er ging iets mis bij het laden van de producten.');
  }
});

app.post('/public/assistant', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return sendError(res, 503, 'AI is nog niet geactiveerd op de server.');
    }

    const clean = validateAssistantInput(req.body || {});
    const answer = await askBlessVegsAssistant(clean.message);

    return sendSuccess(res, 'AI antwoord klaar.', {
      answer
    });
  } catch (error) {
    console.error('Public assistant route error:', error);
    return sendError(
      res,
      error.statusCode || 500,
      error.message || 'AI antwoord ophalen mislukt.'
    );
  }
});

app.get('/public/reviews', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(12);

    if (error) {
      console.error('Public reviews error:', error);
      return sendError(res, 500, 'Reviews konden niet geladen worden.');
    }

    return sendSuccess(res, 'Publieke reviews geladen.', data || []);
  } catch (error) {
    console.error('Public reviews route error:', error);
    return sendError(res, 500, 'Er ging iets mis bij het laden van reviews.');
  }
});

app.post('/public/reviews', async (req, res) => {
  try {
    const clean = validateReviewInput(req.body || {});

    const payload = {
      name: clean.name,
      message: clean.message,
      approved: false
    };

    const { data, error } = await supabase
      .from('reviews')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      console.error('Create public review error:', error);
      return sendError(res, 500, 'Review versturen mislukt.');
    }

    return sendSuccess(
      res,
      'Bedankt. Je bericht is ontvangen en wordt na controle zichtbaar.',
      data,
      201
    );
  } catch (error) {
    console.error('Create public review route error:', error);
    return sendError(
      res,
      error.statusCode || 500,
      error.message || 'Review versturen mislukt.'
    );
  }
});

app.get('/admin/products', requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('producten')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: false });

    if (error) {
      console.error('Admin products error:', error);
      return sendError(res, 500, 'Admin producten konden niet geladen worden.');
    }

    return sendSuccess(
      res,
      'Admin producten geladen.',
      (data || []).map(normalizeProductRecord).map(enrichProduct)
    );
  } catch (error) {
    console.error('Admin products route error:', error);
    return sendError(res, 500, 'Er ging iets mis bij het laden van admin producten.');
  }
});

app.post('/admin/products', requireAuth, async (req, res) => {
  try {
    const input = req.body || {};
    const verkoop_type = input.verkoop_type || 'stuk';
    const basis_eenheid = input.basis_eenheid || input.voorraad_type || 'stuk';
    const voorraad_eenheid = input.voorraad_eenheid || input.voorraad_type || basis_eenheid;

    const preparedInput = {
      ...input,
      verkoop_type,
      basis_eenheid,
      voorraad_eenheid,
      minimum_bestelhoeveelheid: input.minimum_bestelhoeveelheid ?? (verkoop_type === 'gewicht' ? 250 : 1),
      stapgrootte: input.stapgrootte ?? (verkoop_type === 'gewicht' ? 250 : 1),
      basis_prijs: input.basis_prijs ?? input.prijs,
      voorraad_aantal: input.voorraad_aantal ?? input.voorraad
    };

    validateProductInput(preparedInput);

    const payload = {
      name: String(preparedInput.name || '').trim(),
      beschrijving: String(preparedInput.beschrijving || '').trim() || null,
      foto: String(preparedInput.foto || '').trim() || null,
      actief: preparedInput.actief !== false,
      verkoop_type: preparedInput.verkoop_type,
      basis_prijs: toNumber(preparedInput.basis_prijs, 0),
      basis_eenheid: preparedInput.basis_eenheid,
      referentie_eenheid: preparedInput.referentie_eenheid || null,
      minimum_bestelhoeveelheid: toNumber(preparedInput.minimum_bestelhoeveelheid, 1),
      stapgrootte: toNumber(preparedInput.stapgrootte, 1),
      maximum_bestelhoeveelheid: preparedInput.maximum_bestelhoeveelheid === '' || preparedInput.maximum_bestelhoeveelheid == null
        ? null
        : toNumber(preparedInput.maximum_bestelhoeveelheid, null),
      voorraad_aantal: toNumber(preparedInput.voorraad_aantal, 0),
      voorraad_eenheid: preparedInput.voorraad_eenheid,
      kortingsprijs: preparedInput.kortingsprijs === '' || preparedInput.kortingsprijs == null ? 0 : toNumber(preparedInput.kortingsprijs, 0),
      sort_order: toNumber(preparedInput.sort_order, 0),
      prijs: toNumber(preparedInput.basis_prijs, 0),
      voorraad: toNumber(preparedInput.voorraad_aantal, 0),
      voorraad_type: preparedInput.voorraad_eenheid,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('producten')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      console.error('Create product error:', error);
      return sendError(res, 500, 'Product toevoegen mislukt.');
    }

    return sendSuccess(
      res,
      'Product opgeslagen.',
      enrichProduct(normalizeProductRecord(data)),
      201
    );
  } catch (error) {
    console.error('Create product route error:', error);
    return sendError(
      res,
      error.statusCode || 500,
      error.message || 'Product toevoegen mislukt.'
    );
  }
});

app.put('/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'Ongeldig product id.');
    }

    const input = req.body || {};
    const verkoop_type = input.verkoop_type || 'stuk';
    const basis_eenheid = input.basis_eenheid || input.voorraad_type || 'stuk';
    const voorraad_eenheid = input.voorraad_eenheid || input.voorraad_type || basis_eenheid;

    const preparedInput = {
      ...input,
      verkoop_type,
      basis_eenheid,
      voorraad_eenheid,
      minimum_bestelhoeveelheid: input.minimum_bestelhoeveelheid ?? (verkoop_type === 'gewicht' ? 250 : 1),
      stapgrootte: input.stapgrootte ?? (verkoop_type === 'gewicht' ? 250 : 1),
      basis_prijs: input.basis_prijs ?? input.prijs,
      voorraad_aantal: input.voorraad_aantal ?? input.voorraad
    };

    validateProductInput(preparedInput);

    const payload = {
      name: String(preparedInput.name || '').trim(),
      beschrijving: String(preparedInput.beschrijving || '').trim() || null,
      foto: String(preparedInput.foto || '').trim() || null,
      actief: preparedInput.actief !== false,
      verkoop_type: preparedInput.verkoop_type,
      basis_prijs: toNumber(preparedInput.basis_prijs, 0),
      basis_eenheid: preparedInput.basis_eenheid,
      referentie_eenheid: preparedInput.referentie_eenheid || null,
      minimum_bestelhoeveelheid: toNumber(preparedInput.minimum_bestelhoeveelheid, 1),
      stapgrootte: toNumber(preparedInput.stapgrootte, 1),
      maximum_bestelhoeveelheid: preparedInput.maximum_bestelhoeveelheid === '' || preparedInput.maximum_bestelhoeveelheid == null
        ? null
        : toNumber(preparedInput.maximum_bestelhoeveelheid, null),
      voorraad_aantal: toNumber(preparedInput.voorraad_aantal, 0),
      voorraad_eenheid: preparedInput.voorraad_eenheid,
      kortingsprijs: preparedInput.kortingsprijs === '' || preparedInput.kortingsprijs == null ? 0 : toNumber(preparedInput.kortingsprijs, 0),
      sort_order: toNumber(preparedInput.sort_order, 0),
      prijs: toNumber(preparedInput.basis_prijs, 0),
      voorraad: toNumber(preparedInput.voorraad_aantal, 0),
      voorraad_type: preparedInput.voorraad_eenheid,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('producten')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Update product error:', error);
      return sendError(res, 500, 'Product bijwerken mislukt.');
    }

    if (!data) {
      return sendError(res, 404, 'Product niet gevonden.');
    }

    return sendSuccess(
      res,
      'Product bijgewerkt.',
      enrichProduct(normalizeProductRecord(data))
    );
  } catch (error) {
    console.error('Update product route error:', error);
    return sendError(
      res,
      error.statusCode || 500,
      error.message || 'Product bijwerken mislukt.'
    );
  }
});

app.delete('/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'Ongeldig product id.');
    }

    const { data, error } = await supabase
      .from('producten')
      .delete()
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Delete product error:', error);
      return sendError(res, 500, 'Product verwijderen mislukt.');
    }

    if (!data) {
      return sendError(res, 404, 'Product niet gevonden.');
    }

    return sendSuccess(
      res,
      'Product verwijderd.',
      enrichProduct(normalizeProductRecord(data))
    );
  } catch (error) {
    console.error('Delete product route error:', error);
    return sendError(res, 500, 'Product verwijderen mislukt.');
  }
});

app.get('/admin/reviews', requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Admin reviews error:', error);
      return sendError(res, 500, 'Reviews konden niet geladen worden.');
    }

    return sendSuccess(res, 'Reviews geladen.', data || []);
  } catch (error) {
    console.error('Admin reviews route error:', error);
    return sendError(res, 500, 'Er ging iets mis bij het laden van reviews.');
  }
});

app.put('/admin/reviews/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const approved = req.body?.approved === true;

    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'Ongeldig review id.');
    }

    const { data, error } = await supabase
      .from('reviews')
      .update({ approved })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Update review error:', error);
      return sendError(res, 500, 'Review bijwerken mislukt.');
    }

    if (!data) {
      return sendError(res, 404, 'Review niet gevonden.');
    }

    return sendSuccess(res, 'Review bijgewerkt.', data);
  } catch (error) {
    console.error('Update review route error:', error);
    return sendError(res, 500, 'Review bijwerken mislukt.');
  }
});

app.delete('/admin/reviews/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'Ongeldig review id.');
    }

    const { data, error } = await supabase
      .from('reviews')
      .delete()
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Delete review error:', error);
      return sendError(res, 500, 'Review verwijderen mislukt.');
    }

    if (!data) {
      return sendError(res, 404, 'Review niet gevonden.');
    }

    return sendSuccess(res, 'Review verwijderd.', data);
  } catch (error) {
    console.error('Delete review route error:', error);
    return sendError(res, 500, 'Review verwijderen mislukt.');
  }
});

app.use((_req, res) => {
  return sendError(res, 404, 'Route niet gevonden.');
});

app.listen(PORT, () => {
  console.log(`Bless Vegs backend running on port ${PORT}`);
});