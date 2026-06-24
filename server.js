// Kairos Brewing — storefront standalone (Express + Shopify)
// Sirve el front estático en /public y expone el catálogo de Kairos en vivo
// desde el MISMO Shopify que usa Zorbo. El checkout se hace con el permalink
// /cart/{variantId}:{qty} → checkout nativo de Shopify (Transbank, etc.).

import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, appendFile, readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(compression());

// Apex → www (preserva el path). El forwarding de GoDaddy bota la ruta, así
// que cuando el apex apunte directo a Railway, este middleware se encarga.
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:.*$/, '').toLowerCase();
  if (host === 'kairos-brewing.com') {
    return res.redirect(301, `https://www.kairos-brewing.com${req.originalUrl}`);
  }
  next();
});

const PORT = process.env.PORT || 3000;

const SHOPIFY_API_VERSION = '2026-04';
const SHOP   = process.env.SHOPIFY_STORE_DOMAIN;   // kairos-brewing.myshopify.com
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;    // shpat_...
const VENDOR = process.env.KAIROS_VENDOR || 'Kairos Brewing';

// ─── Catálogo Shopify ─────────────────────────────────────────────────────────
let cache = null;
let cacheAt = 0;
const TTL_MS = 5 * 60 * 1000;

// Productos/handles a ocultar siempre (tests, eventos, recargas, reservas).
const HIDE_HANDLES = new Set([
  'producto-de-prueba', 'evento', 'recarga-co2', 'reserva-cumpleanos',
]);
const HIDE_TITLE_RX = /^(pago factura|reservas?|recarga)/i;

// Ubicaciones cuyo stock se muestra en la PDP (solo los locales de venta).
// Usamos keywords flexibles porque Shopify puede tenerlos con / sin "Kairos"
// y con distintos nombres (Garden Vespucio, etc.).
const SHOW_LOCATION_RX = /garden|badass|antofagasta|vespucio/i;

// Mayorista = no se muestra en la tienda B2C de Kairos.
function isMayorista(p) {
  const tags = (p.tags || []).map(t => t.toUpperCase());
  if (tags.includes('MAYORISTA')) return true;
  const title = (p.title || '').toLowerCase();
  if (title.startsWith('barril ') || title.startsWith('bidon ')) return true;
  if (/^\d+\s*pack.*mayorista/i.test(p.title || '')) return true;
  return false;
}

const stripGid = (gid, kind) => String(gid || '').replace(`gid://shopify/${kind}/`, '');

const PRODUCTS_QUERY = `{
  products(first: 250, query: "status:active") {
    edges {
      node {
        id title handle productType vendor tags descriptionHtml
        featuredImage { url altText }
        images(first: 6) { edges { node { url altText } } }
        collections(first: 10) { edges { node { handle title } } }
        variants(first: 25) {
          edges {
            node {
              id title price compareAtPrice sku
              availableForSale inventoryQuantity
              image { url }
            }
          }
        }
      }
    }
  }
}`;

const PAGES_QUERY = `{
  pages(first: 100) {
    edges { node { id title handle body bodySummary updatedAt } }
  }
}`;

async function shopifyGraphQL(query) {
  if (!SHOP || !TOKEN) {
    throw new Error('Shopify no configurado (faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_TOKEN).');
  }
  const r = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// Devuelve SOLO productos del vendor Kairos (incluye los individuales que no
// están en Zorbo), excluyendo mayorista y ocultos.
async function loadKairosProducts(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache.products;
  const resp = await shopifyGraphQL(PRODUCTS_QUERY);
  if (resp.errors) throw new Error(JSON.stringify(resp.errors));

  const products = resp.data.products.edges
    .map(({ node: p }) => ({
      id:          stripGid(p.id, 'Product'),
      handle:      p.handle,
      title:       p.title,
      type:        p.productType,
      vendor:      p.vendor,
      tags:        p.tags,
      descriptionHtml: p.descriptionHtml || '',
      image:       p.featuredImage?.url || null,
      images:      (p.images?.edges || []).map(e => e.node.url),
      collections: (p.collections?.edges || []).map(e => ({ handle: e.node.handle, title: e.node.title })),
      variants: p.variants.edges.map(({ node: v }) => ({
        id:             stripGid(v.id, 'ProductVariant'),
        title:          v.title,
        price:          v.price,
        compareAtPrice: v.compareAtPrice,
        sku:            v.sku,
        available:      v.availableForSale,
        stock:          v.inventoryQuantity,
        image:          v.image?.url || null,
        locations: [],
      })),
    }))
    .filter(p => (p.vendor || '').trim().toLowerCase() === VENDOR.toLowerCase())
    .filter(p => !HIDE_HANDLES.has(p.handle))
    .filter(p => !HIDE_TITLE_RX.test(p.title || ''))
    .filter(p => !isMayorista(p));

  cache = { products, fetchedAt: new Date().toISOString() };
  cacheAt = Date.now();
  return products;
}

// ─── Páginas de contenido (/pages/{handle}) ──────────────────────────────────
let pagesCache = null;
let pagesAt = 0;
async function loadPages(force = false) {
  if (!force && pagesCache && Date.now() - pagesAt < TTL_MS) return pagesCache;
  const resp = await shopifyGraphQL(PAGES_QUERY);
  if (resp.errors) throw new Error(JSON.stringify(resp.errors));
  const pages = (resp.data.pages?.edges || []).map(({ node: p }) => ({
    id:      stripGid(p.id, 'OnlineStorePage'),
    title:   p.title,
    handle:  p.handle,
    body:    p.body || '',
    summary: p.bodySummary || '',
    updatedAt: p.updatedAt,
  }));
  pagesCache = pages;
  pagesAt = Date.now();
  return pages;
}

app.get('/api/pages', async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: 'Shopify no está conectado.' });
  try {
    const pages = await loadPages(req.query.refresh === '1');
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ count: pages.length, pages });
  } catch (e) {
    console.error('Shopify pages error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products', async (req, res) => {
  if (!TOKEN) {
    return res.status(503).json({ error: 'Shopify no está conectado. Falta SHOPIFY_ADMIN_TOKEN.' });
  }
  try {
    const products = await loadKairosProducts(req.query.refresh === '1');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ count: products.length, products, fetchedAt: cache?.fetchedAt });
  } catch (e) {
    console.error('Shopify products error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cart-link?items=44123:2,44987:1 → URL de checkout pre-cargado.
app.get('/api/cart-link', (req, res) => {
  if (!SHOP) return res.status(500).json({ error: 'SHOPIFY_STORE_DOMAIN no configurado.' });
  const items = String(req.query.items || '');
  if (!/^\d+:\d+(,\d+:\d+)*$/.test(items)) {
    return res.status(400).json({ error: 'Formato inválido. Esperaba variantId:qty,variantId:qty' });
  }
  res.json({ url: `https://${SHOP}/cart/${items}` });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ─── Backup de predicciones del Mundial ───────────────────────────────────────
// iDTE/Flapp sobreescribe los cart.attributes del pedido en Shopify cuando
// emite la boleta SII, borrando las predicciones. Para no depender de eso,
// guardamos el pronóstico en NUESTRO server apenas el cliente lo envía, antes
// del checkout. Después se cruza por hora con el pedido de Shopify (la
// diferencia entre submit del form y checkout suele ser 1-3 min).
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const PREDICTIONS_FILE = join(DATA_DIR, 'mundial-predictions.jsonl');
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

app.post('/api/mundial-prediction', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const record = {
      ts: new Date().toISOString(),
      campeon:    String(b.campeon    || ''),
      subcampeon: String(b.subcampeon || ''),
      tercero:    String(b.tercero    || ''),
      goleador:   String(b.goleador   || ''),
      twelvepack: String(b.twelvepack || ''),
    };
    if (!record.campeon && !record.goleador) {
      return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(PREDICTIONS_FILE, JSON.stringify(record) + '\n', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    console.error('mundial-prediction error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function requireAdmin(req, res) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    res.status(503).json({ error: 'Admin no configurado. Falta ADMIN_USER y ADMIN_PASS en Railway.' });
    return false;
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Kairos Admin"');
    res.status(401).end('Auth requerida');
    return false;
  }
  try {
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return true;
  } catch {}
  res.set('WWW-Authenticate', 'Basic realm="Kairos Admin"');
  res.status(401).end('Credenciales inválidas');
  return false;
}

app.get('/api/admin/predictions', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = await readFile(PREDICTIONS_FILE, 'utf8').catch(() => '');
    const records = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (req.query.format === 'csv') {
      const cols = ['ts','campeon','subcampeon','tercero','goleador','twelvepack'];
      const escape = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
      const csv = '﻿' + [cols.join(',')].concat(records.map(r => cols.map(c => escape(r[c])).join(','))).join('\n');
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="mundial-predictions-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }
    res.json({ count: records.length, predictions: records });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/newsletter — suscribe el email a la lista Kairos de Klaviyo (Tc9EC9).
// Si KLAVIYO_PRIVATE_KEY está seteada en el entorno, primero verifica si el email
// ya está en la lista y devuelve already_subscribed:true sin re-suscribir.
const KLAVIYO_LIST_ID = 'Tc9EC9';
const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY || '';
const KLAVIYO_REVISION = '2024-10-15';

async function klaviyoFetch(path) {
  if (!KLAVIYO_PRIVATE_KEY) return null;
  const r = await fetch(`https://a.klaviyo.com/api${path}`, {
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
      'Accept': 'application/vnd.api+json',
      'revision': KLAVIYO_REVISION,
    },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function isAlreadyInList(email) {
  if (!KLAVIYO_PRIVATE_KEY) return null; // sin private key, no podemos chequear
  try {
    const filter = `equals(email,"${email.replace(/"/g, '\\"')}")`;
    const search = await klaviyoFetch(`/profiles/?filter=${encodeURIComponent(filter)}`);
    const profiles = search?.data || [];
    if (!profiles.length) return false;
    const profileId = profiles[0].id;
    const memberships = await klaviyoFetch(`/profiles/${profileId}/lists/`);
    const lists = memberships?.data || [];
    return lists.some(l => l.id === KLAVIYO_LIST_ID);
  } catch (e) {
    console.warn('Klaviyo dedupe check failed:', e.message);
    return null;
  }
}

app.post('/api/newsletter', express.json(), async (req, res) => {
  try {
    const { name, email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Email inválido' });
    }
    // 1) Si tenemos private key, chequear si ya está en la lista.
    const inList = await isAlreadyInList(email);
    if (inList === true) {
      return res.json({ success: true, already_subscribed: true });
    }
    // 2) Suscribir vía endpoint público (legacy, sin auth).
    const params = new URLSearchParams();
    params.set('g', KLAVIYO_LIST_ID);
    params.set('email', email);
    if (name) params.set('$first_name', name);
    const r = await fetch('https://manage.kmail-lists.com/ajax/subscriptions/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    res.json({ success: !!data.success, data });
  } catch (e) {
    console.error('newsletter error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Front estático + SPA ──────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

// Todas las rutas de la SPA (excepto /api/*) devuelven index.html; el router
// del front renderea la vista según el path.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Kairos storefront en http://localhost:${PORT}`);
  if (!SHOP || !TOKEN) {
    console.warn('⚠️  Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_TOKEN — el catálogo no cargará.');
  } else {
    // Precalienta los cachés.
    loadKairosProducts().then(p => console.log(`Catálogo precargado: ${p.length} productos`)).catch(e => console.warn('Precarga productos falló:', e.message));
    loadPages().then(p => console.log(`Páginas precargadas: ${p.length}`)).catch(e => console.warn('Precarga páginas falló:', e.message));
  }
});
