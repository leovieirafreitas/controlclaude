// Vencimento no mesmo dia para todos os clientes NOVOS, com o 1º pagamento proporcional (pro rata).
//
// Exemplo com vencimento no dia 30 (fevereiro: último dia) e plano de R$ 200:
//   assina dia 15 → paga 15 dias (R$ 100,00) e depois R$ 200 todo dia 30
//   assina dia 25 → faltam 5 dias (7 ou menos): paga os 5 dias + o mês seguinte inteiro (R$ 233,33) e só volta a pagar no dia 30 do outro mês
//   assina dia 31 → paga os dias até o dia 30 do mês seguinte (proporcional) e depois R$ 200 todo dia 30
//   assina dia 30 → mês cheio, sem ajuste
//
// Configuração (tabela settings): prorata_on = on|off (padrão: on) · prorata_day = 1..30 (padrão: 30; em mês mais curto, vale o último dia)
import { get } from './db.js';

export const PRORATA_DEFAULT_DAY = 30; // "final do mês": dia 30; em fevereiro, o último dia (28 ou 29)
export const MAX_DUE_DAY = 30;

/** Data do vencimento (AAAA-MM-DD) num mês: o dia combinado, ou o último dia do mês se ele for mais curto (fevereiro). */
export function dueDate(month, dueDay) {
  const [y, m] = String(month).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(month).slice(0, 7)}-${String(Math.min(Number(dueDay) || 1, last)).padStart(2, '0')}`;
}
const MERGE_DAYS = 7; // faltando até 7 dias para o vencimento: cobra junto o mês seguinte

export async function prorataConfig() {
  const rows = await Promise.all(['prorata_on', 'prorata_day'].map((k) => get('SELECT value FROM settings WHERE key = ?', [k])));
  const on = !/^(off|0|false|nao|não)$/i.test(String(rows[0]?.value || 'on').trim());
  const d = Number(rows[1]?.value);
  return { on, day: Number.isInteger(d) && d >= 1 && d <= MAX_DUE_DAY ? d : PRORATA_DEFAULT_DAY };
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
  if (!y || !monthly) return null;
  const iso = (yy, mm) => dueDate(ym(yy, mm), dueDay); // em mês curto, cai no último dia
  const dueThis = Number(iso(y, m).slice(8, 10));
  if (d === dueThis) return null; // hoje é o vencimento: mês cheio
  const before = d < dueThis; // o vencimento deste mês ainda não chegou
  const dueISO = before ? iso(y, m) : iso(y, m + 1);
  const days = Math.round((Date.parse(dueISO) - Date.UTC(y, m - 1, d)) / 86_400_000);
  const part = Math.round((monthly * Math.min(days, 30)) / 30);
  if (before) {
    if (days <= MERGE_DAYS) {
      // vencimento logo ali: paga os dias que faltam + o mês que começa nele (o pagamento quita o mês atual)
      return { cents: part + monthly, month: ym(y, m), days, part_cents: part, merged: true, next_due: iso(y, m + 1) };
    }
    // paga só os dias até o vencimento deste mês; nele vence a 1ª mensalidade cheia.
    // Na contabilidade, este pagamento quita o ciclo anterior (mês passado), para o mês atual continuar em aberto.
    return { cents: part, month: ym(y, m - 1), days, part_cents: part, merged: false, next_due: dueISO };
  }
  if (days <= MERGE_DAYS) {
    // fim do mês, vencimento logo no começo do próximo: proporcional + o mês seguinte (o pagamento quita o mês seguinte)
    return { cents: part + monthly, month: ym(y, m + 1), days, part_cents: part, merged: true, next_due: iso(y, m + 2) };
  }
  return { cents: part, month: ym(y, m), days, part_cents: part, merged: false, next_due: dueISO };
}
