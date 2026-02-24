# Indoo — Deployment Guide

## Files in this project

```
login.html          ← auth entry point (sign in / sign up)
index.html          ← main agents page (role-aware)
dashboard.html      ← analytics dashboard
admin.html          ← admin-only user & access management
index.css           ← shared styles for index
dashboard.css       ← dashboard styles
supabase_setup.sql  ← run this once in Supabase
vercel.json         ← Vercel routing config
```

---

## Step 1 — Create a Supabase project

1. Go to **supabase.com** → New Project
2. Choose a name (e.g. `indoo`) and a strong database password
3. Wait ~2 minutes for it to spin up
4. Go to **Settings → API** and copy:
   - **Project URL** → looks like `https://xxxx.supabase.co`
   - **anon / public key** → long JWT string

---

## Step 2 — Run the database setup

1. In your Supabase dashboard → **SQL Editor → New Query**
2. Paste the entire contents of `supabase_setup.sql`
3. Click **Run**
4. You should see "Success. No rows returned."

This creates:
- `profiles` table (users + roles)
- `agents` table (your ElevenLabs agents)
- `agent_access` table (which client sees which agent)
- `pending_invites` table
- All Row Level Security policies
- Auto-create profile trigger on sign-up
- Auto-promote first user to admin

---

## Step 3 — Add your Supabase credentials to the code

In **each of these 3 files**, find these two lines near the top of the `<script>` tag and replace the placeholder values:

```
login.html
index.html
admin.html
```

Find:
```javascript
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Replace with your actual values:
```javascript
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_KEY = 'eyJhbGci...your-anon-key...';
```

---

## Step 4 — Enable email auth in Supabase

1. Supabase Dashboard → **Authentication → Providers**
2. Make sure **Email** is enabled
3. Under **Authentication → Settings**, you can optionally:
   - Disable "Confirm email" for easier testing (re-enable in production)

---

## Step 5 — Deploy to Vercel

### Option A — Drag & Drop (easiest)
1. Go to **vercel.com** → Add New Project
2. Choose **"Deploy without Git"**
3. Drag and drop your entire project folder
4. Click Deploy → done in ~10 seconds
5. You'll get a URL like `your-project.vercel.app`

### Option B — Via CLI
```bash
npm i -g vercel
cd your-project-folder
vercel
# Follow prompts, framework = Other
```

---

## Step 6 — First login (you become Admin automatically)

1. Go to your deployed URL → you'll be redirected to `login.html`
2. Click **Sign Up** and create your account
3. **The first user to sign up is automatically made Admin** (handled by the SQL trigger)
4. Sign in — you'll see the full dashboard with Add Agent + Admin Panel

---

## Step 7 — Invite your mentor (Client role)

### Option A — Let them sign up, then set role
1. Share the URL with your mentor
2. They sign up themselves
3. You go to **Admin Panel → Users → Edit Role** → set to Client
4. Then **Assign Agents** to give them access to specific agents

### Option B — Pre-invite (sets role on signup)
1. Go to **Admin Panel → Invite User**
2. Enter their email and select role = Client
3. When they sign up with that email, they automatically get the Client role

---

## Role permissions summary

| Feature                        | Admin | Client |
|-------------------------------|-------|--------|
| View assigned agents          | ✅    | ✅     |
| View all agents               | ✅    | ❌     |
| Add / edit / remove agents    | ✅    | ❌     |
| Open analytics dashboard      | ✅    | ✅     |
| Access Admin Panel            | ✅    | ❌     |
| Manage users & roles          | ✅    | ❌     |
| Assign agents to clients      | ✅    | ❌     |

---

## Security notes

- API keys are stored in Supabase Postgres (encrypted at rest)
- Row Level Security (RLS) ensures clients can only query their own data
- The anon key is safe to use client-side — RLS enforces all restrictions
- Clients can never see agents they haven't been assigned
