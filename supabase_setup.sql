

-- ── 1. PROFILES ─────────────────────────────────────────────
-- Mirrors auth.users and stores role + display name
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'client' check (role in ('admin','client')),
  created_at  timestamptz default now()
);

-- Auto-create a profile row whenever a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    -- First ever user automatically becomes admin; everyone else is client
    case when (select count(*) from public.profiles) = 0 then 'admin' else 'client' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ── 2. AGENTS ────────────────────────────────────────────────
create table if not exists public.agents (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  agent_id    text,                  -- ElevenLabs agent ID
  api_key     text,                  -- ElevenLabs API key (stored encrypted at rest by Supabase)
  emoji       text default '🤖',
  color       text default 'lav',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz default now()
);


-- ── 3. AGENT ACCESS ──────────────────────────────────────────
-- Maps which client users can see which agents
create table if not exists public.agent_access (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles(id) on delete cascade,
  agent_id  uuid not null references public.agents(id) on delete cascade,
  unique(user_id, agent_id)
);


-- ── 4. PENDING INVITES ───────────────────────────────────────
-- Records invite intentions so the admin flow works
create table if not exists public.pending_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        text not null default 'client',
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz default now()
);

-- When a new user signs up, apply any pending invite role
create or replace function public.apply_pending_invite()
returns trigger language plpgsql security definer as $$
declare
  pending_role text;
begin
  select role into pending_role
  from public.pending_invites
  where email = new.email
  order by created_at desc
  limit 1;

  if found then
    update public.profiles set role = pending_role where id = new.id;
    delete from public.pending_invites where email = new.email;
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.apply_pending_invite();


-- ══════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY (RLS)
-- ══════════════════════════════════════════════════════════════

alter table public.profiles      enable row level security;
alter table public.agents        enable row level security;
alter table public.agent_access  enable row level security;
alter table public.pending_invites enable row level security;


-- ── PROFILES policies ────────────────────────────────────────

-- Users can read their own profile
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Admins can read all profiles
create policy "Admins can view all profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Admins can update any profile (e.g. change role)
create policy "Admins can update profiles"
  on public.profiles for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Admins can delete profiles
create policy "Admins can delete profiles"
  on public.profiles for delete
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- The trigger inserts profiles, so allow inserts from the trigger function
create policy "Allow trigger inserts on profiles"
  on public.profiles for insert
  with check (true);


-- ── AGENTS policies ──────────────────────────────────────────

-- Admins can do everything with agents
create policy "Admins full access to agents"
  on public.agents for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Clients can only read agents they have access to
create policy "Clients can read assigned agents"
  on public.agents for select
  using (
    exists (
      select 1 from public.agent_access aa
      where aa.agent_id = agents.id and aa.user_id = auth.uid()
    )
  );


-- ── AGENT_ACCESS policies ────────────────────────────────────

-- Admins can manage all access rows
create policy "Admins full access to agent_access"
  on public.agent_access for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Clients can read their own access rows
create policy "Clients can view own access"
  on public.agent_access for select
  using (auth.uid() = user_id);


-- ── PENDING_INVITES policies ─────────────────────────────────

-- Only admins can manage invites
create policy "Admins full access to pending_invites"
  on public.pending_invites for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );


-- ══════════════════════════════════════════════════════════════
--  DONE! Your database is ready.
-- ══════════════════════════════════════════════════════════════
