-- Templates for consultation notes. Built-in templates have owner_id null.
-- Safe to run more than once.
create table if not exists public.templates (
    id uuid primary key default gen_random_uuid(),
    owner_id text null,
    name text not null,
    specialty text,
    kind text check (kind in ('new', 'follow_up', 'condition')),
    current_version int not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists templates_owner_idx on public.templates (owner_id);

-- Every saved version, never changed afterwards. A note points at the version it was made with.
create table if not exists public.template_versions (
    template_id uuid not null references public.templates (id) on delete cascade,
    version int not null,
    definition jsonb not null,
    created_at timestamptz not null default now(),
    primary key (template_id, version)
);

-- Deleting a template hides it; notes made with it keep their layout
alter table public.templates add column if not exists archived boolean not null default false;

alter table public.doctors add column if not exists default_template_id uuid null;

-- Backend only, like every other table (see rls_apply.sql)
alter table public.templates enable row level security;
alter table public.template_versions enable row level security;
revoke all on public.templates from anon, authenticated;
revoke all on public.template_versions from anon, authenticated;
