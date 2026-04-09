const express = require('express');
const cors = require('cors');
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
    beschrijving: row.beschrijving || row.omschrijving || '',
    foto: row.foto || row.afbeelding || '',
    slug: slugify(row.name)
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
  const basis_eenheid = input.basis_eenheid || 'stuk';
  const minimum = toNumber(input.minimum_bestelhoeveelheid, NaN);
  const stap = toNumber(input.stapgrootte, NaN);
  const maximum = input.maximum_bestelhoeveelheid === '' || input.maximum_bestelhoeveelheid == null
    ? null
    : toNumber(input.maximum_bestelhoeveelheid, NaN);
  const voorraad_aantal = toNumber(input.voorraad_aantal ?? input.voorraad, NaN);
  const voorraad_eenheid = input.voorraad_eenheid || 'stuk';

  if (!String(input.name || '').trim()) {
    errors.push('Productnaam is verplicht.');
  }

  if (!['stuk', 'bos', 'bakje', 'gewicht'].includes(verkoop_type)) {
    errors.push('Ongeldig verkoop_type.');
  }

  if (!['stuk', 'bos', 'bakje', 'kg', 'g'].includes(basis_eenheid)) {
    errors.push('Ongeldige basis_eenheid.');
  }

  if (!['stuk', 'bos', 'bakje', 'kg', 'g'].includes(voorraad_eenheid)) {
    errors.push('Ongeldige voorraad_eenheid.');
  }

  if (!Number.isFinite(basis_prijs) || basis_prijs < 0) {
    errors.push('Basisprijs is ongeldig.');
  }

  if (!Number.isFinite(voorraad_aantal) || voorraad_aantal < 0) {
    errors.push('Voorraad is ongeldig.');
  }

  if (!Number.isFinite(minimum) || minimum <= 0) {
    errors.push('Minimum bestelhoeveelheid is ongeldig.');
  }

  if (!Number.isFinite(stap) || stap <= 0) {
    errors.push('Stapgrootte is ongeldig.');
  }

  if (maximum !== null && (!Number.isFinite(maximum) || maximum <= 0)) {
    errors.push('Maximum bestelhoeveelheid is ongeldig.');
  }

  if (Number.isFinite(kortingsprijs) && kortingsprijs > 0 && kortingsprijs >= basis_prijs) {
    errors.push('Kortingsprijs moet lager zijn dan basisprijs.');
  }

  if (verkoop_type === 'gewicht') {
    if (!['kg', 'g'].includes(basis_eenheid)) {
      errors.push('Gewicht-product moet basis_eenheid kg of g hebben.');
    }
    if (!['kg', 'g'].includes(voorraad_eenheid)) {
      errors.push('Gewicht-product moet voorraad_eenheid kg of g hebben.');
    }
  } else {
    if (!['stuk', 'bos', 'bakje'].includes(basis_eenheid)) {
      errors.push('Niet-gewicht product moet basis_eenheid stuk, bos of bakje hebben.');
    }
    if (minimum !== 1) {
      errors.push('Voor stuk/bos/bakje moet minimum_bestelhoeveelheid 1 zijn.');
    }
    if (stap !== 1) {
      errors.push('Voor stuk/bos/bakje moet stapgrootte 1 zijn.');
    }
    if (voorraad_eenheid !== basis_eenheid) {
      errors.push('Voorraad_eenheid moet gelijk zijn aan basis_eenheid bij stuk/bos/bakje.');
    }
  }

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.statusCode = 400;
    throw error;
  }
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: 'Ongeldige sessie.' });
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'ok' });
});

app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Gebruikersnaam en wachtwoord zijn verplicht.' });
    }

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'Onjuiste inloggegevens.' });
    }

    const token = jwt.sign(
      { username: ADMIN_USERNAME, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({ ok: true, token });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Inloggen mislukt.' });
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
      return res.status(500).json({ ok: false, error: 'Kon producten niet laden' });
    }

    const products = (data || [])
      .map(normalizeProductRecord)
      .map(enrichProduct);

    return res.json({ ok: true, data: products });
  } catch (error) {
    console.error('Public products route error:', error);
    return res.status(500).json({ ok: false, error: 'Kon producten niet laden' });
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
      return res.status(500).json({ ok: false, error: 'Kon admin producten niet laden.' });
    }

    return res.json({
      ok: true,
      data: (data || []).map(normalizeProductRecord).map(enrichProduct)
    });
  } catch (error) {
    console.error('Admin products route error:', error);
    return res.status(500).json({ ok: false, error: 'Kon admin producten niet laden.' });
  }
});

app.post('/admin/products', requireAuth, async (req, res) => {
  try {
    validateProductInput(req.body || {});

    const payload = {
      name: String(req.body.name || '').trim(),
      beschrijving: String(req.body.beschrijving || '').trim() || null,
      foto: String(req.body.foto || '').trim() || null,
      actief: req.body.actief !== false,
      verkoop_type: req.body.verkoop_type,
      basis_prijs: toNumber(req.body.basis_prijs, 0),
      basis_eenheid: req.body.basis_eenheid,
      referentie_eenheid: req.body.referentie_eenheid || null,
      minimum_bestelhoeveelheid: toNumber(req.body.minimum_bestelhoeveelheid, 1),
      stapgrootte: toNumber(req.body.stapgrootte, 1),
      maximum_bestelhoeveelheid: req.body.maximum_bestelhoeveelheid === '' || req.body.maximum_bestelhoeveelheid == null
        ? null
        : toNumber(req.body.maximum_bestelhoeveelheid, null),
      voorraad_aantal: toNumber(req.body.voorraad_aantal, 0),
      voorraad_eenheid: req.body.voorraad_eenheid,
      kortingsprijs: req.body.kortingsprijs === '' || req.body.kortingsprijs == null ? 0 : toNumber(req.body.kortingsprijs, 0),
      sort_order: toNumber(req.body.sort_order, 0),
      prijs: toNumber(req.body.basis_prijs, 0),
      voorraad: toNumber(req.body.voorraad_aantal, 0),
      voorraad_type: req.body.voorraad_eenheid,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('producten')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      console.error('Create product error:', error);
      return res.status(500).json({ ok: false, error: 'Product toevoegen mislukt.' });
    }

    return res.status(201).json({ ok: true, data: enrichProduct(normalizeProductRecord(data)) });
  } catch (error) {
    console.error('Create product route error:', error);
    return res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Product toevoegen mislukt.' });
  }
});

app.put('/admin/products/:id', requireAuth, async (req, res) => {
  try {
    validateProductInput(req.body || {});

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'Ongeldig product id.' });
    }

    const payload = {
      name: String(req.body.name || '').trim(),
      beschrijving: String(req.body.beschrijving || '').trim() || null,
      foto: String(req.body.foto || '').trim() || null,
      actief: req.body.actief !== false,
      verkoop_type: req.body.verkoop_type,
      basis_prijs: toNumber(req.body.basis_prijs, 0),
      basis_eenheid: req.body.basis_eenheid,
      referentie_eenheid: req.body.referentie_eenheid || null,
      minimum_bestelhoeveelheid: toNumber(req.body.minimum_bestelhoeveelheid, 1),
      stapgrootte: toNumber(req.body.stapgrootte, 1),
      maximum_bestelhoeveelheid: req.body.maximum_bestelhoeveelheid === '' || req.body.maximum_bestelhoeveelheid == null
        ? null
        : toNumber(req.body.maximum_bestelhoeveelheid, null),
      voorraad_aantal: toNumber(req.body.voorraad_aantal, 0),
      voorraad_eenheid: req.body.voorraad_eenheid,
      kortingsprijs: req.body.kortingsprijs === '' || req.body.kortingsprijs == null ? 0 : toNumber(req.body.kortingsprijs, 0),
      sort_order: toNumber(req.body.sort_order, 0),
      prijs: toNumber(req.body.basis_prijs, 0),
      voorraad: toNumber(req.body.voorraad_aantal, 0),
      voorraad_type: req.body.voorraad_eenheid,
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
      return res.status(500).json({ ok: false, error: 'Product bijwerken mislukt.' });
    }

    return res.json({ ok: true, data: enrichProduct(normalizeProductRecord(data)) });
  } catch (error) {
    console.error('Update product route error:', error);
    return res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Product bijwerken mislukt.' });
  }
});

app.delete('/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'Ongeldig product id.' });
    }

    const { error } = await supabase
      .from('producten')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Delete product error:', error);
      return res.status(500).json({ ok: false, error: 'Product verwijderen mislukt.' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Delete product route error:', error);
    return res.status(500).json({ ok: false, error: 'Product verwijderen mislukt.' });
  }
});

app.use((_req, res) => {
  return res.status(404).json({ ok: false, error: 'Route niet gevonden' });
});

app.listen(PORT, () => {
  console.log(`Bless Vegs backend running on port ${PORT}`);
});
