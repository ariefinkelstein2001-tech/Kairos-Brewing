// Kairos Brewing — storefront standalone (Express + Shopify)
// Sirve el front estático en /public y expone el catálogo de Kairos en vivo
// desde el MISMO Shopify que usa Zorbo. El checkout se hace con el permalink
// /cart/{variantId}:{qty} → checkout nativo de Shopify (Transbank, etc.).

import express from 'express';
import compression from 'compression';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

async function shopifyGraphQL(query, variables) {
  if (!SHOP || !TOKEN) {
    throw new Error('Shopify no configurado (faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_TOKEN).');
  }
  const r = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify(variables ? { query, variables } : { query }),
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

// ─── Arma tu Pack para el 18 (precio fijo, vaso incluido) ────────────────────
// Espeja la clasificación de cervezas del front (public/index.html) para
// validar en el servidor qué variantes puede elegir el cliente: solo latas
// individuales (no packs/destilados/merch) y sin la colección World Tour.
function p18IsPack(p) {
  const t = (p.title || '').toLowerCase();
  return /^\s*pack\b/.test(t) || /\d+\s*pack/.test(t) || /\bcatador\b|\bamateur\b|mundialero|world\s*tour/.test(t);
}
function p18IsDestilado(p) {
  const t = (p.title || '').toLowerCase();
  const type = (p.type || '').toLowerCase();
  if (/destil|licor|spirit|gin/.test(type)) return true;
  if ((p.collections || []).some(c => /destil|licor|spirit|gin/i.test((c.handle || '') + ' ' + (c.title || '')))) return true;
  return /\bgin\b|banny|london dry|whisky|whiskey|\bron\b|\brum\b|vermut|mojito|tonic|rtd/.test(t);
}
function p18IsMerch(p) {
  const t = (p.title || '').toLowerCase();
  const type = (p.type || '').toLowerCase();
  if (/camiseta|polera|poler[oó]n|ropa|merch|accesori|gorro|jockey|vaso|jarra|copa|textil|prenda/.test(type)) return true;
  if ((p.collections || []).some(c => /merch|tienda|ropa|accesori/i.test((c.handle || '') + ' ' + (c.title || '')))) return true;
  return /vaso|jockey|jarra|copa|growler|\bpin\b|gorr|camiseta|polera|poler[oó]n|hoodie|poler/.test(t);
}
function p18IsWorldTour(p) {
  const cols = (p.collections || []).map(c => ((c.handle || '') + ' ' + (c.title || '')).toLowerCase());
  const h = (p.handle || '').toLowerCase();
  return cols.some(c => /world.?tour/.test(c)) || /lanus|lanús|osagui|acholada/.test(h);
}
function p18IsArtista(p) {
  const cols = (p.collections || []).map(c => ((c.handle || '') + ' ' + (c.title || '')).toLowerCase());
  return cols.some(c => /artist/.test(c));
}
// Cerveza elegible para el Pack 18: lata individual, sin World Tour ni De
// Artista, no destilado/merch/pack, sin tag ZORBO ni suscripción.
function p18IsEligibleBeer(p) {
  if ((p.tags || []).some(t => /^(oculto|hidden|privado|link.?only)$/i.test(String(t)))) return false;
  if (p18IsPack(p) || p18IsDestilado(p) || p18IsMerch(p) || p18IsWorldTour(p) || p18IsArtista(p)) return false;
  if ((p.tags || []).map(t => String(t).toUpperCase()).includes('ZORBO')) return false;
  if (/suscrip|subscription|chelada|firulais/i.test(p.title || '')) return false;
  const t = (p.title || '').toLowerCase();
  const type = (p.type || '').toLowerCase();
  const sku = ((p.variants && p.variants[0] && p.variants[0].sku) || '').toLowerCase();
  if (type.includes('cerveza')) return true;
  if (/\d{3}\s*cc/.test(t) || /\d{3}\s*cc/.test(sku)) return true;
  if ((p.collections || []).some(c => /casa|temporada|artist|chelita/i.test((c.handle || '') + ' ' + (c.title || '')))) return true;
  return false;
}

const PACK18_PRICE = { 6: 13990, 12: 25990, 24: 40990 };
const PACK18_VASO_LABEL = { 6: 'vaso de 250 cc incluido', 12: 'vaso de 500 cc incluido', 24: '2 vasos de 500 cc incluidos' };
// Vaso real por tamaño de pack: "Vaso Cognac Kairos Brewing 250cc - Copa de
// Degustación Premium" para el 6 Pack, "Vaso Schopero ... 500cc" (x1 o x2)
// para 12/24. Se busca por palabra clave + cc en vez de título exacto para no
// romperse si Shopify cambia levemente el nombre del producto.
const PACK18_VASO_SPEC = {
  6:  { rx: /cognac/i,   cc: '250', qty: 1 },
  12: { rx: /schopero/i, cc: '500', qty: 1 },
  24: { rx: /schopero/i, cc: '500', qty: 2 },
};
function p18FindVaso(products, spec) {
  const p = products.find(pr => spec.rx.test(pr.title || '') && pr.title.includes(spec.cc));
  const v0 = p && (p.variants || [])[0];
  return v0 && v0.id ? { title: p.title, variantId: String(v0.id), price: parseFloat(v0.price || 0) } : null;
}

const DISCOUNT_CODE_CREATE_MUTATION = `
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

// POST /api/pack18/checkout { size, variantIds:[...] } → valida las latas
// elegidas contra el catálogo real, arma las líneas (latas + vaso real del
// tamaño) y, si la suma real supera el precio fijo del Pack 18, crea un
// código de descuento de un solo uso (monto fijo, vence en 1 hora) por la
// diferencia exacta. El front agrega esas líneas al carrito normal de
// Shopify con ese código pre-aplicado vía /discount/{code}?redirect=/checkout
// — así el checkout sigue siendo el normal del sitio (con la caja de código
// visible) en vez de una Orden Borrador, que la ocultaba. El precio y las
// variantes válidas siempre se recalculan en el servidor, nunca se confía en
// lo que mande el cliente.
app.post('/api/pack18/checkout', express.json(), async (req, res) => {
  if (!SHOP || !TOKEN) return res.status(503).json({ error: 'Shopify no está conectado.' });
  try {
    const size = parseInt(req.body?.size, 10);
    const variantIds = Array.isArray(req.body?.variantIds) ? req.body.variantIds.map(String).filter(Boolean) : [];
    if (!PACK18_PRICE[size]) return res.status(400).json({ error: 'Tamaño de pack inválido.' });
    if (variantIds.length !== size) return res.status(400).json({ error: `Debes elegir exactamente ${size} cervezas.` });

    const products = await loadKairosProducts();
    const eligible = new Map();
    products.filter(p18IsEligibleBeer).forEach(p => {
      (p.variants || []).forEach(v => { if (v.id) eligible.set(String(v.id), parseFloat(v.price || 0)); });
    });

    let realSum = 0;
    const qtyByVariant = new Map();
    for (const id of variantIds) {
      if (!eligible.has(id)) return res.status(400).json({ error: 'Una de las cervezas elegidas no está disponible para el Pack 18.' });
      realSum += eligible.get(id);
      qtyByVariant.set(id, (qtyByVariant.get(id) || 0) + 1);
    }

    const fixedPrice = PACK18_PRICE[size];
    const lineItems = [...qtyByVariant.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));

    // Agrega el vaso real del tamaño de pack como línea propia (para que se
    // vea en el carrito y se descuente del inventario). El carrito público de
    // Shopify solo acepta variantes reales — si el producto no se encuentra
    // por nombre, se omite la línea (el total sigue siendo el fijo igual) y
    // queda un warning en los logs para revisar el nombre del producto.
    const vasoSpec = PACK18_VASO_SPEC[size];
    const vaso = p18FindVaso(products, vasoSpec);
    let vasoRealSum = 0;
    if (vaso) {
      lineItems.push({ variantId: vaso.variantId, quantity: vasoSpec.qty });
      vasoRealSum = vaso.price * vasoSpec.qty;
    } else {
      console.warn(`pack18: vaso ${vasoSpec.cc}cc no encontrado en el catálogo (esperaba título con "${vasoSpec.rx}"), no se agrega línea de vaso`);
    }
    realSum += vasoRealSum;

    let code = null;
    const discountAmount = Math.round((realSum - fixedPrice) * 100) / 100;
    if (discountAmount > 0) {
      code = `PACK18-${size}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const now = new Date();
      const input = {
        title: `Pack para el 18 · ${size} unidades (${PACK18_VASO_LABEL[size]})`,
        code,
        startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: false,
        customerSelection: { all: true },
        customerGets: {
          value: { discountAmount: { amount: discountAmount, appliesOnEachItem: false } },
          items: { all: true },
        },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      };
      const resp = await shopifyGraphQL(DISCOUNT_CODE_CREATE_MUTATION, { basicCodeDiscount: input });
      if (resp.errors) throw new Error(JSON.stringify(resp.errors));
      const { userErrors } = resp.data.discountCodeBasicCreate;
      if (userErrors && userErrors.length) {
        return res.status(400).json({ error: userErrors.map(e => e.message).join('; ') });
      }
    }

    res.json({ lineItems, code });
  } catch (e) {
    console.error('pack18 checkout error:', e.message);
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

// ─── Inventario por local (solo Garden, Garden Antofagasta y Badass) ──────────
// Endpoint separado y tolerante a fallos: si la query de inventario falla (p.ej.
// falta el scope read_inventory), devuelve locations:[] sin romper el catálogo.
const INV_TTL = 2 * 60 * 1000;
const invCache = new Map(); // productId -> { at, locations }

const INVENTORY_QUERY = (gid) => `{
  product(id: "${gid}") {
    variants(first: 30) {
      edges { node {
        inventoryItem {
          inventoryLevels(first: 20) {
            edges { node {
              location { name }
              quantities(names: ["available"]) { name quantity }
            } }
          }
        }
      } }
    }
  }
}`;

app.get('/api/inventory', async (req, res) => {
  const id = String(req.query.product || '').replace(/\D/g, '');
  if (!TOKEN || !id) return res.json({ locations: [] });
  const cached = invCache.get(id);
  if (cached && Date.now() - cached.at < INV_TTL) return res.json({ locations: cached.locations });
  try {
    const resp = await shopifyGraphQL(INVENTORY_QUERY(`gid://shopify/Product/${id}`));
    if (resp.errors) throw new Error(JSON.stringify(resp.errors));
    const map = {};
    (resp.data?.product?.variants?.edges || []).forEach(({ node: v }) => {
      (v.inventoryItem?.inventoryLevels?.edges || []).forEach(({ node: lvl }) => {
        const name = lvl.location?.name || '';
        if (!SHOW_LOCATION_RX.test(name)) return;
        const q = (lvl.quantities || []).find(x => x.name === 'available')?.quantity ?? 0;
        map[name] = (map[name] || 0) + (parseInt(q, 10) || 0);
      });
    });
    const locations = Object.keys(map).map(name => ({ name, stock: map[name] }));
    invCache.set(id, { at: Date.now(), locations });
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ locations });
  } catch (e) {
    console.warn('inventory error:', e.message);
    res.json({ locations: [], error: e.message });
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

// Página standalone del Pasaporte Cervecero (fuera del router del SPA).
app.get('/pasaporte-cervecero', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'pasaporte-cervecero.html'));
});

// Página standalone de la Trivia Cervecera (fuera del router del SPA).
app.get('/trivia-cervecera', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'trivia-cervecera.html'));
});

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
