-- ─── Pindrop — Supabase Setup ────────────────────────────────────────────────
-- Paste this entire file into your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- As of v0.9.3, Pindrop only creates 'pin' annotations (drawing/highlight were
-- removed — see ROADMAP.md). This constraint only applies to *new* installs
-- (create table if not exists won't touch a table that already exists) — if
-- you're running this against a project that already has drawing/highlight
-- rows from an earlier version, do NOT re-run this file expecting it to
-- migrate or clean those up; that needs a deliberate, separate migration.
create table if not exists pindrop_annotations (
  id           uuid        primary key default gen_random_uuid(),
  page_url     text        not null,
  type         text        not null check (type in ('pin')),

  -- Pin fields
  x_doc        float8,           -- absolute X from left of document (px)
  y_doc        float8,           -- absolute Y from top of document (px)
  color        text,             -- hex colour

  -- Element anchor — repositions as the layout reflows (resize, rotation,
  -- content changes); see resolveAnchor() in pindrop.js
  anchor       jsonb,            -- { selector, offset_x_pct, offset_y_pct }

  -- Common
  comment         text,
  author_name     text        not null default 'Anonymous',
  author_token    text,             -- random localStorage token for delete ownership
  resolved        boolean     not null default false,
  created_at      timestamptz not null default now(),

  -- DOM context snapshot; compared on load to flag stale annotations
  dom_fingerprint text,

  -- Supabase Auth UID for persistent cross-device ownership
  user_id         uuid references auth.users(id) on delete set null
);

create table if not exists pindrop_replies (
  id             uuid        primary key default gen_random_uuid(),
  annotation_id  uuid        not null references pindrop_annotations(id) on delete cascade,
  author_name    text        not null default 'Anonymous',
  author_token   text,
  comment        text        not null,
  created_at     timestamptz not null default now(),

  -- Supabase Auth UID for persistent cross-device ownership
  user_id        uuid references auth.users(id) on delete set null
);

create table if not exists pindrop_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table pindrop_annotations enable row level security;
alter table pindrop_replies     enable row level security;
alter table pindrop_profiles    enable row level security;

create policy "public read"   on pindrop_annotations for select using (true);
create policy "public insert" on pindrop_annotations for insert with check (true);
create policy "public update" on pindrop_annotations for update using (true) with check (true);
create policy "public delete" on pindrop_annotations for delete using (true);

create policy "public read"   on pindrop_replies for select using (true);
create policy "public insert" on pindrop_replies for insert with check (true);
create policy "public update" on pindrop_replies for update using (true) with check (true);
create policy "public delete" on pindrop_replies for delete using (true);

create policy "public read"  on pindrop_profiles for select using (true);
create policy "own insert"   on pindrop_profiles for insert with check (auth.uid() = id);
create policy "own update"   on pindrop_profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- ─── Realtime ─────────────────────────────────────────────────────────────────
-- Enable Realtime so live annotation feed, presence, and cursors work.
alter publication supabase_realtime add table pindrop_annotations;
alter publication supabase_realtime add table pindrop_replies;

-- Full replica identity so UPDATE and DELETE events include the row id.
alter table pindrop_annotations replica identity full;
alter table pindrop_replies     replica identity full;
