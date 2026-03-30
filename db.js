import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('neon')
    ? { rejectUnauthorized: false }
    : false
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS streamers (
      id             TEXT PRIMARY KEY,
      twitch_id      TEXT UNIQUE NOT NULL,
      twitch_login   TEXT NOT NULL,
      twitch_display TEXT NOT NULL,
      access_token   TEXT,
      refresh_token  TEXT,
      expires_at     BIGINT DEFAULT 0,
      reward_title   TEXT DEFAULT 'Шанс на "любой скин"',
      min_num        INTEGER DEFAULT 1,
      max_num        INTEGER DEFAULT 100,
      panel_bg_color TEXT DEFAULT '#101014',
      name_color     TEXT DEFAULT '#ffffff',
      num_color      TEXT DEFAULT '#ffffff',
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whitelist (
      twitch_login TEXT PRIMARY KEY,
      source       TEXT DEFAULT 'admin',
      note         TEXT DEFAULT '',
      expires_at   TIMESTAMP DEFAULT NULL,
      added_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migrate: add columns if they don't exist yet (for existing deployments)
  await pool.query(`ALTER TABLE whitelist ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'admin'`);
  await pool.query(`ALTER TABLE whitelist ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL`);

  console.log('✅ DB ready');
}

// ─── Whitelist ────────────────────────────────────────────────────────────────

export async function getWhitelistEntry(twitchLogin) {
  const r = await pool.query(
    'SELECT * FROM whitelist WHERE LOWER(twitch_login) = LOWER($1)',
    [twitchLogin]
  );
  return r.rows[0] || null;
}

export async function isWhitelisted(twitchLogin) {
  const entry = await getWhitelistEntry(twitchLogin);
  if (!entry) return false;
  // expires_at NULL = permanent (admin-added)
  if (!entry.expires_at) return true;
  return new Date(entry.expires_at) > new Date();
}

export async function getWhitelist() {
  const r = await pool.query('SELECT * FROM whitelist ORDER BY added_at DESC');
  return r.rows;
}

export async function addToWhitelist(twitchLogin, { source = 'admin', note = '', days = null } = {}) {
  const expires = days ? new Date(Date.now() + days * 86400000) : null;
  await pool.query(`
    INSERT INTO whitelist (twitch_login, source, note, expires_at)
    VALUES (LOWER($1), $2, $3, $4)
    ON CONFLICT (twitch_login) DO UPDATE SET
      source     = EXCLUDED.source,
      note       = EXCLUDED.note,
      expires_at = EXCLUDED.expires_at,
      added_at   = NOW()
  `, [twitchLogin, source, note, expires]);
}

export async function removeFromWhitelist(twitchLogin) {
  await pool.query('DELETE FROM whitelist WHERE LOWER(twitch_login) = LOWER($1)', [twitchLogin]);
}

// ─── Streamers ────────────────────────────────────────────────────────────────

export async function getStreamer(id) {
  const r = await pool.query('SELECT * FROM streamers WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function getStreamerByTwitchId(twitchId) {
  const r = await pool.query('SELECT * FROM streamers WHERE twitch_id = $1', [twitchId]);
  return r.rows[0] || null;
}

export async function getStreamerByLogin(login) {
  const r = await pool.query('SELECT * FROM streamers WHERE LOWER(twitch_login) = LOWER($1)', [login]);
  return r.rows[0] || null;
}

export async function getAllStreamersWithTokens() {
  const r = await pool.query('SELECT * FROM streamers WHERE access_token IS NOT NULL');
  return r.rows;
}

export async function upsertStreamer(data) {
  const r = await pool.query(`
    INSERT INTO streamers (id, twitch_id, twitch_login, twitch_display, access_token, refresh_token, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (twitch_id) DO UPDATE SET
      access_token   = EXCLUDED.access_token,
      refresh_token  = EXCLUDED.refresh_token,
      expires_at     = EXCLUDED.expires_at,
      twitch_login   = EXCLUDED.twitch_login,
      twitch_display = EXCLUDED.twitch_display
    RETURNING *
  `, [data.id, data.twitch_id, data.twitch_login, data.twitch_display,
      data.access_token, data.refresh_token, data.expires_at]);
  return r.rows[0];
}

export async function updateTokens(id, { access_token, refresh_token, expires_at }) {
  await pool.query(
    'UPDATE streamers SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=$4',
    [access_token, refresh_token, expires_at, id]
  );
}

export async function updateSettings(id, settings) {
  const keys = Object.keys(settings);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  await pool.query(
    `UPDATE streamers SET ${sets} WHERE id=$1`,
    [id, ...Object.values(settings)]
  );
}
