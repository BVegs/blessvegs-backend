const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// TEST
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 👉 PRODUCTEN OPHALEN
app.get('/public/products', async (req, res) => {
  const { data, error } = await supabase
    .from('producten')
    .select('*');

  if (error) {
    return res.json({ ok: false, error });
  }

  return res.json({ ok: true, data: data || [] });
});

// 👉 PRODUCT TOEVOEGEN (GEEN VALIDATIE = GEEN FOUTEN)
app.post('/admin/products', async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      name: body.name,
      prijs: Number(body.prijs || 0),
      kortingsprijs: Number(body.kortingsprijs || 0),
      voorraad: Number(body.voorraad || 0),
      voorraad_type: body.voorraad_type || 'stuk',
      beschrijving: body.beschrijving || '',
      foto: body.foto || ''
    };

    const { data, error } = await supabase
      .from('producten')
      .insert(payload)
      .select()
      .single();

    if (error) {
      return res.json({ ok: false, error });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

app.listen(10000, () => {
  console.log('backend draait');
});
