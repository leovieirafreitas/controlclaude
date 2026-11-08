// Banco de dados: Postgres do Supabase.
// As tabelas e o RLS ficam em supabase/schema.sql e supabase/rls.sql.
// O servidor conecta como dono do banco (DATABASE_URL), por isso não é afetado pelo RLS;
// visitantes com a chave pública (anon) continuam bloqueados pelas políticas.
import pg from 'pg';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL || DATABASE_URL.includes('SUA-SENHA')) {
  console.error('ERRO: defina DATABASE_URL no arquivo .env com a senha do banco do Supabase.');
  process.exit(1);
}

// Tipos do Postgres → JavaScript
pg.types.setTypeParser(20, (v) => Number(v));       // bigint (ids, COUNT, SUM) → número
pg.types.setTypeParser(1700, (v) => Number(v));     // numeric → número
pg.types.setTypeParser(1082, (v) => v);             // date → 'AAAA-MM-DD'
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz → ISO

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  // Abrir conexão custa ~1 s (SSL + pooler): não fechar por inatividade
  idleTimeoutMillis: 0,
  keepAlive: true,
});
pool.on('error', (err) => console.error('Postgres (conexão parada):', err.message));
// O Supabase às vezes derruba conexões abertas (ECONNRESET). Sem este "ouvinte" em cada conexão,
// o erro numa conexão em uso derrubava o servidor inteiro. Agora só registra; o pool abre outra.
pool.on('connect', (client) => {
  client.on('error', (err) => console.error('Postgres (conexão perdida, será reaberta):', err.message));
});

// Já deixa conexões abertas ao iniciar e as mantém vivas (evita a 1ª tela lenta depois de uma pausa)
const WARM = 5; // = max do pool: o Dashboard faz 4 consultas ao mesmo tempo
async function warm() {
  const clients = await Promise.all(Array.from({ length: WARM }, () => pool.connect().catch(() => null)));
  await Promise.all(clients.filter(Boolean).map((c) => c.query('select 1').finally(() => c.release())));
}
warm().catch(() => {});
setInterval(() => warm().catch(() => {}), 4 * 60_000).unref();

// Permite escrever "?" nos SQLs; vira $1, $2... para o Postgres
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export const query = (sql, params = []) => pool.query(toPg(sql), params);
export const all = async (sql, params) => (await query(sql, params)).rows;
export const get = async (sql, params) => (await query(sql, params)).rows[0];
/** Executa e retorna { rowCount, rows } — use "RETURNING id" para pegar o id criado. */
export const run = (sql, params) => query(sql, params);
