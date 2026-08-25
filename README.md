# Pindrop

**Drop-in design annotation tool for any website.**  
Leave pins, draw on the page, highlight text, and have threaded conversations — all wired to your own free Supabase database.

![Pindrop in action](https://via.placeholder.com/800x400?text=Pindrop+screenshot)

---

## Features

- 📍 **Pins** — click anywhere to drop a numbered pin with a comment
- ✏️ **Freehand drawing** — draw directly on the page
- 🖍️ **Text highlights** — select any text to highlight and annotate it
- 💬 **Threaded replies** — comment on any annotation
- ✓ **Resolve** — mark feedback as done; resolved items collapse automatically
- 🗑️ **Delete** — anonymous ownership via localStorage token
- 🎯 **Focus mode** — click any annotation to dim everything else
- 📐 **Element anchoring** — pins reposition correctly across screen sizes
- 🔒 **Your data** — everything goes to your own Supabase project

---

## Setup

### 1. Create your Supabase table

Go to your [Supabase](https://supabase.com) project → SQL Editor → paste and run `supabase-setup.sql`.

### 2. Get your credentials

In Supabase: **Settings → API**
- Copy the **Project URL**
- Copy the **anon / public** key (under "Legacy anon, service_role API keys" if needed)

### 3. Add one script tag

```html
<script
  src="https://cdn.jsdelivr.net/gh/kaleb-tcm/pindrop/pindrop.min.js"
  data-supabase-url="https://YOUR_PROJECT_ID.supabase.co"
  data-supabase-key="eyJ..."
  defer
></script>
```

That's it. A ✏️ button appears in the bottom-right corner.

---

## Options

| Attribute | Default | Description |
|-----------|---------|-------------|
| `data-supabase-url` | *(required)* | Your Supabase project URL |
| `data-supabase-key` | *(required)* | Your Supabase anon/public key |
| `data-page-key` | `window.location.pathname` | Custom identifier for this page |
| `data-position` | `bottom-right` | Toggle button corner: `bottom-right` or `bottom-left` |

---

## How it works

Pindrop is a single self-contained JavaScript file with no build step and no framework dependencies. It lazy-loads the Supabase JS client from jsDelivr, then wires everything up — toolbar, canvas overlay, SVG layer, sidebar — entirely in vanilla JS.

**Anonymous ownership** — on first visit a random token is generated and stored in `localStorage`. This token is saved with every annotation you create, and the Delete button only appears on annotations that match your token.

**Element anchoring** — pins store a CSS selector path to the DOM element they were placed on, plus a percentage offset within that element. On resize or reload, the pin repositions itself relative to the element rather than using absolute pixel coordinates.

---

## License

MIT
