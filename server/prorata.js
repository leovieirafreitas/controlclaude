// Vencimento no mesmo dia para todos os clientes NOVOS, com o 1º pagamento proporcional (pro rata).
//
// Exemplo com vencimento no dia 5 e plano de R$ 200:
//   assina dia 15 → paga 20 dias (R$ 133,33) e depois R$ 200 todo dia 5
//   assina dia 2  → faltam 3 dias: paga os 3 dias + o mês seguinte inteiro (R$ 220) e só volta a pagar no dia 5 do outro mês
//   assina dia 29 → faltam 6 dias (7 ou menos): mesma regra, proporcional + mês seguinte
//   assina dia 5  → mês cheio, sem ajuste
//
// Configuração (tabela settings): prorata_on = on|off (padrão: on) · prorata_day = 1..28 (padrão: 5)
import { get } from './db.js';

export const PRORATA_DEFAULT_DAY = 5;
const MERGE_DAYS = 7; // faltando até 7 dias para o vencimento: cobra junto o mês seguinte

export async function prorataConfig() {
  const rows = await Promise.all(['prorata_on', 'prorata_day'].map((k) => get('SELECT value FROM settings WHERE key = ?', [k])));
  const on = !/^(off|0|false|nao|não)$/i.test(String(rows[0]?.value || 'on').trim());
  const d = Number(rows[1]?.value);
  return { on, day: Number.isInteger(d) && d >= 1 && d <= 28 ? d : PRORATA_DEFAULT_DAY };
}

const ym = (y, m) => { // m: 1..12, aceita estouro (13 = janeiro do ano seguinte)
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Primeiro pagamento de quem assina hoje.
 * Retorna null se hoje é o próprio dia do vencimento (mês cheio, sem ajuste). Senão:
 *   { cents, month, days, part_cents, merged, next_due }
 *   - cents: quanto pagar agora · part_cents: só a parte proporcional
 *   - month: mês (AAAA-MM) que este pagamento quita · merged: inclui o mês seguinte inteiro
 *   - next_due: data (AAAA-MM-DD) da próxima mensalidade cheia
 */
export function firstCharge(todayISO, dueDay, monthlyCents) {
  const [y, m, d] = String(todayISO).slice(0, 10).split('-').map(Number);
  const monthly = Math.max(0, Math.round(Number(monthlyCents) || 0));
  if (!y || !monthly || d === dueDay) return null;
  const iso = (yy, mm) => `${ym(yy, mm)}-${String(dueDay).padStart(2, '0')}`;
  const before = d < dueDay; // o vencimento deste mês ainda não chegou
  const dueISO = before ? iso(y, m) : iso(y, m + 1);
  const days = Math.round((Date.parse(dueISO) - Date.UTC(y, m - 1, d)) / 86_400_000);
  const part = Math.round((monthly * Math.min(days, 30)) / 30);
  if (before) {
    // paga os dias até o vencimento + o mês que começa nele (o pagamento quita o mês atual)
    return { cents: part + monthly, month: ym(y, m), days, part_cents: part, merged: true, next_due: iso(y, m + 1) };
  }
  if (days <= MERGE_DAYS) {
    // fim do mês, vencimento logo no começo do próximo: proporcional + o mês seguinte (o pagamento quita o mês seguinte)
    return { cents: part + monthly, month: ym(y, m + 1), days, part_cents: part, merged: true, next_due: iso(y, m + 2) };
  }
  return { cents: part, month: ym(y, m), days, part_cents: part, merged: false, next_due: dueISO };
}
