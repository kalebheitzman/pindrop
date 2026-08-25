-- ─── Pindrop — Supabase Setup ────────────────────────────────────────────────
-- Paste this entire file into your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists pindrop_annotations (
  id           uuid        primary key default gen_random_uuid(),
  page_url     text        not null,
  type         text        not null check (type in ('pin', 'drawing', 'highlight')),

  -- Pin fields
  x_doc        float8,           -- absolute X from left of document (px)
  y_doc        float8,           -- absolute Y from top of document (px)
  color        text,             -- hex colour

  -- Element anchor (pins) — repositions across screen sizes
  anchor       jsonb,            -- { selector, offset_x_pct, offset_y_pct }

  -- Drawing / highlight fields
  paths        jsonb,            -- drawings: [{points:[{x,y}…], color, width}]
                                 -- highlights: [{x,y,w,h,sel?}…]

  -- Common
  comment      text,
  author_name  text        not null default 'Anonymous',
  author_token text,             -- random localStorage token for delete ownership
  resolved     boolean     not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists pindrop_replies (
  id             uuid        primary key default gen_random_uuid(),
  annotation_id  uuid        not null references pindrop_annotations(id) on delete cascade,
  author_name    text        not null default 'Anonymous',
  author_token   text,
  comment        text        not null,
  created_at     timestamptz not null default now()
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table pindrop_annotations enable row level security;
alter table pindrop_replies     enable row level security;

create policy "public read"   on pindrop_annotations for select using (true);
create policy "public insert" on pindrop_annotations for insert with check (true);
create policy "public update" on pindrop_annotations for update using (true) with check (true);
create policy "public delete" on pindrop_annotations for delete using (true);

create policy "public read"   on pindrop_replies for select using (true);
create policy "public insert" on pindrop_replies for insert with check (true);
create policy "public delete" on pindrop_replies for delete using (true);
