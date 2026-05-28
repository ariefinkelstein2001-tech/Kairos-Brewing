# Kairos Brewing — Storefront

Sitio web de Kairos Brewing, independiente de Shopify, pensado para hostear en
Railway. Recrea kairos-brewing.com con código limpio y se conecta al **mismo
Shopify** que el proyecto Zorbo para mostrar productos en vivo y mandar el
checkout al pago nativo de Shopify (Transbank, etc.).

## Cómo funciona

- **Front** (`public/index.html`): mini-SPA con hero, cervezas, packs,
  destilería, merch, restaurantes, eventos y nosotros. Responsive (mobile).
- **Catálogo en vivo** (`GET /api/products`): lee desde Shopify Admin GraphQL y
  devuelve **solo los productos del vendor "Kairos Brewing"** (incluye las
  cervezas individuales que NO están en Zorbo), excluyendo mayorista y ocultos.
  Precio, stock y fotos salen de Shopify en tiempo real (cache de 5 min).
- **Carrito**: vive en `localStorage`, con contador, totales y botón de pago.
- **Checkout**: arma el permalink `https://{shop}/cart/{variantId}:{qty},...`,
  que crea un carrito real en Shopify y lleva al checkout nativo. No necesita
  token para el checkout.

## Variables de entorno

| Variable | Obligatoria | Valor |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | Sí | `kairos-brewing.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Sí | el `shpat_…` que ya usas en el Railway de Zorbo |
| `PORT` | No | lo inyecta Railway solo (local: 3000) |
| `KAIROS_VENDOR` | No | por defecto `Kairos Brewing` |

> El `SHOPIFY_ADMIN_TOKEN` necesita scope `read_products` (y `read_inventory`
> para el stock). Es el mismo token que ya tienes en Zorbo.

## Correr localmente

```bash
npm install
cp .env.example .env   # y completa SHOPIFY_ADMIN_TOKEN
npm start              # http://localhost:3000
```

## Deploy en Railway

1. Sube este repo a GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**.
3. Carga las variables `SHOPIFY_STORE_DOMAIN` y `SHOPIFY_ADMIN_TOKEN`.
4. Railway detecta Node y corre `npm start`. El `PORT` se inyecta solo.

## Notas

- Para un sitio público, lo más prolijo a futuro es leer el catálogo con el
  **Storefront API** (token público de solo lectura) en vez del Admin token.
  Hoy usa Admin para reutilizar el token existente de Zorbo sin fricción.
- El checkout apunta a `SHOPIFY_STORE_DOMAIN`. Si configuras un dominio propio
  en Shopify, el permalink seguirá funcionando igual.
