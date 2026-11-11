// Modelos editáveis das mensagens: notificações push do painel e mensagens de WhatsApp para os clientes.
// O texto padrão fica aqui; o que o admin muda na tela fica na tabela settings (chave message_templates).
// No texto, {variavel} é trocada pelo valor real. Uma linha com {link} some quando o site não tem endereço.
import { get, run } from './db.js';

const STORE_KEY = 'message_templates';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
// Mesma chave do member.js / whatsapp.js: com o Pix desligado, os textos padrão não podem oferecer Pix
const PIX_ON = !/^(off|0|false|nao|não)$/i.test(process.env.PIX_ENABLED || 'on');

/** Variáveis disponíveis (nome → explicação e exemplo para a pré-visualização e o teste). */
export const VARS = {
  nome: { label: 'Primeiro nome do cliente', sample: 'Maria' },
  cliente: { label: 'Nome completo do cliente', sample: 'Maria Silva' },
  email: { label: 'E-mail do cliente', sample: 'maria@exemplo.com' },
  telefone: { label: 'WhatsApp do cliente', sample: '(92) 99999-0000' },
  plano: { label: 'Nome do plano', sample: 'Claude Code Pro' },
  valor: { label: 'Valor (R$)', sample: 'R$ 50,00' },
  forma: { label: 'Forma de pagamento', sample: 'Pix' },
  mes: { label: 'Mês de referência', sample: '12/2026' },
  vencimento: { label: 'Data de vencimento', sample: '10/12/2026' },
  dia_vencimento: { label: 'Dia do vencimento', sample: '10' },
  dias: { label: 'Dias até o vencimento', sample: '3 dias' },
  cartao: { label: 'Final do cartão', sample: 'final 1234' },
  acesso_ate: { label: 'Último dia de acesso', sample: '10/12/2026' },
  formas_pagamento: { label: 'Formas de pagamento aceitas', sample: 'cartão de crédito ou Pix' },
  link: { label: 'Link da área do assinante', sample: `${APP_URL || 'https://controlclaude.com.br'}/conta` },
};

const w = (lines) => lines.join('\n');

/**
 * Catálogo. channel: push (para o admin) | whatsapp (para o cliente).
 * on: ligado por padrão. vars: variáveis que fazem sentido nesta mensagem.
 */
export const CATALOG = [
  // ------------------------------------------------------------ notificações push (celular do admin)
  { key: 'push_nova_assinatura', channel: 'push', group: 'Pagamentos', label: 'Nova assinatura', hint: 'Primeiro pagamento de um cliente.',
    on: true, vars: ['plano', 'valor', 'forma', 'cliente'], title: 'Nova assinatura', body: '{plano} · {valor}', url: '/admin#payments' },
  { key: 'push_pagamento', channel: 'push', group: 'Pagamentos', label: 'Pagamento recebido', hint: 'Mensalidades seguintes (Pix, cartão ou renovação automática).',
    on: true, vars: ['plano', 'valor', 'forma', 'cliente', 'mes'], title: 'Pagamento recebido', body: '{plano} · {valor}', url: '/admin#payments' },
  { key: 'push_cadastro', channel: 'push', group: 'Clientes', label: 'Novo cliente cadastrado', hint: 'Alguém criou a conta e confirmou o e-mail (ainda sem pagar).',
    on: true, vars: ['cliente', 'email', 'telefone'], title: 'Novo cliente cadastrado', body: '{cliente}\n{email} · {telefone}\nAinda sem pagamento', url: '/admin#customers' },
  { key: 'push_checkout', channel: 'push', group: 'Clientes', label: 'Não concluiu o pagamento (24h)', hint: 'Escolheu o plano há 24 horas e ainda não pagou.',
    on: false, vars: ['cliente', 'plano', 'valor', 'telefone'], title: 'Pagamento não concluído', body: '{cliente} escolheu o {plano} ({valor}) e ainda não pagou', url: '/admin#customers' },
  { key: 'push_cancelamento', channel: 'push', group: 'Avisos', label: 'Assinatura cancelada', hint: 'O cliente cancelou pela área do assinante.',
    on: false, vars: ['cliente', 'plano', 'acesso_ate'], title: 'Assinatura cancelada', body: '{cliente} · {plano}\nAcesso até {acesso_ate}', url: '/admin#subscribers' },
  { key: 'push_cartao_recusado', channel: 'push', group: 'Avisos', label: 'Cartão recusado', hint: 'O Mercado Pago recusou o cartão do cliente na hora de pagar.',
    on: false, vars: ['cliente', 'plano', 'valor'], title: 'Cartão recusado', body: '{cliente} · {plano} ({valor})', url: '/admin#subscribers' },
  { key: 'push_atraso', channel: 'push', group: 'Avisos', label: 'Mensalidade atrasada', hint: 'Venceu e não foi paga (inclui renovação automática que não passou).',
    on: false, vars: ['cliente', 'plano', 'valor', 'vencimento'], title: 'Mensalidade atrasada', body: '{cliente} · {plano} ({valor})\nVenceu em {vencimento}', url: '/admin#dashboard' },

  // ------------------------------------------------------------ WhatsApp para o cliente
  { key: 'wa_boas_vindas', channel: 'whatsapp', group: 'Pagamento confirmado', label: 'Boas-vindas (1º pagamento)', hint: 'Primeiro pagamento por Pix ou cartão avulso.',
    on: true, vars: ['nome', 'plano', 'valor', 'forma', 'mes', 'dia_vencimento', 'link'], body: w([
      'Olá, {nome}! 🎉', '',
      'Sua assinatura do *{plano}* está ativa. Seja bem-vindo(a) à Control Claude!', '',
      '💵 Pagamento de {valor} via {forma} confirmado ({mes}).',
      '📅 Sua mensalidade vence todo dia {dia_vencimento}.', '',
      'Na sua área você vê seus dados e pagamentos, troca o cartão ou cancela quando quiser:',
      '{link}', '',
      'Qualquer dúvida, é só responder esta mensagem.']) },
  { key: 'wa_boas_vindas_auto', channel: 'whatsapp', group: 'Pagamento confirmado', label: 'Boas-vindas (renovação automática)', hint: 'Primeiro pagamento já com renovação automática no cartão.',
    on: true, vars: ['nome', 'plano', 'valor', 'forma', 'mes', 'dia_vencimento', 'cartao', 'link'], body: w([
      'Olá, {nome}! 🎉', '',
      'Sua assinatura do *{plano}* está ativa. Seja bem-vindo(a) à Control Claude!', '',
      '💵 Pagamento de {valor} via {forma} confirmado ({mes}).',
      '🔁 A renovação é automática: todo mês, por volta do dia {dia_vencimento}, cobramos no seu cartão {cartao}. Você não precisa fazer nada.', '',
      'Na sua área você vê seus dados e pagamentos, troca o cartão ou cancela quando quiser:',
      '{link}', '',
      'Qualquer dúvida, é só responder esta mensagem.']) },
  { key: 'wa_pagamento', channel: 'whatsapp', group: 'Pagamento confirmado', label: 'Pagamento recebido', hint: 'Mensalidades seguintes pagas por Pix ou cartão avulso.',
    on: true, vars: ['nome', 'plano', 'valor', 'forma', 'mes'], body: w([
      'Olá, {nome}! ✅', '',
      'Recebemos seu pagamento de {valor} via {forma}, referente a {mes}.',
      'Seu plano *{plano}* segue ativo. Obrigado!']) },
  { key: 'wa_renovacao', channel: 'whatsapp', group: 'Pagamento confirmado', label: 'Renovação automática feita', hint: 'O Mercado Pago cobrou a mensalidade no cartão.',
    on: true, vars: ['nome', 'plano', 'valor', 'mes', 'cartao'], body: w([
      'Olá, {nome}! ✅', '',
      'A renovação automática do seu plano foi feita: cobramos {valor} no seu cartão {cartao}, referente a {mes}.',
      'Seu plano *{plano}* segue ativo. Obrigado!']) },

  { key: 'wa_aviso_cartao', channel: 'whatsapp', group: 'Antes do vencimento', label: 'Aviso do cartão (5 dias antes)', hint: 'Para quem paga por Pix: convida a ativar a renovação automática.',
    on: true, vars: ['nome', 'plano', 'vencimento', 'link'], body: w([
      'Olá, {nome}! 👋', '',
      'Um aviso rápido sobre a sua assinatura do *{plano}*:', '',
      PIX_ON
        ? 'Novidade: a partir da próxima mensalidade ({vencimento}) você pode ativar a *renovação automática no cartão de crédito*. Cadastra o cartão uma vez e todo mês a cobrança acontece sozinha, sem precisar lembrar de pagar. Se preferir, pode continuar pagando por *Pix* normalmente.'
        : 'A partir da próxima mensalidade ({vencimento}), o pagamento passa a ser *automático no cartão de crédito*. Você cadastra o cartão uma vez e todo mês a cobrança acontece sozinha, sem precisar lembrar de pagar.', '',
      // #4: duas linhas, para só a frase do link sumir quando o site está sem endereço
      'Uns dias antes do vencimento te mandamos o link para pagar.',
      'Se preferir, já pode fazer isso agora na sua área:',
      '👉 {link}', '',
      'Você pode cancelar quando quiser: a cobrança para e o acesso continua até o fim do mês pago.', '',
      'Qualquer dúvida, é só responder esta mensagem.']) },
  { key: 'wa_lembrete', channel: 'whatsapp', group: 'Antes do vencimento', label: 'Lembrete de vencimento', hint: 'Alguns dias antes do vencimento (quem paga por Pix).',
    on: true, vars: ['nome', 'plano', 'valor', 'dias', 'vencimento', 'formas_pagamento', 'link'], body: w([
      'Olá, {nome}! 👋', '',
      'Sua mensalidade do *{plano}* ({valor}) vence em *{dias}*, no dia *{vencimento}*.', '',
      PIX_ON ? 'Para continuar, pague na sua área do assinante com *cartão de crédito* (ativa a *renovação automática* e você não precisa mais se preocupar com o vencimento) ou por *Pix*.'
        : 'Para continuar, pague na sua área do assinante com *cartão de crédito*. Assim você ativa a *renovação automática* e não precisa mais se preocupar com o vencimento.', '',
      '👉 Pagar agora: {link}', '',
      'Se já pagou, desconsidere esta mensagem. 😉']) },
  { key: 'wa_lembrete_hoje', channel: 'whatsapp', group: 'Antes do vencimento', label: 'Vence hoje', hint: 'No dia do vencimento, se o lembrete ainda não tinha saído.',
    on: true, vars: ['nome', 'plano', 'valor', 'vencimento', 'formas_pagamento', 'link'], body: w([
      'Olá, {nome}! 👋', '',
      'Sua mensalidade do *{plano}* ({valor}) vence *hoje* ({vencimento}).', '',
      PIX_ON ? 'Para continuar, pague na sua área do assinante com *cartão de crédito* (ativa a *renovação automática* e você não precisa mais se preocupar com o vencimento) ou por *Pix*.'
        : 'Para continuar, pague na sua área do assinante com *cartão de crédito*. Assim você ativa a *renovação automática* e não precisa mais se preocupar com o vencimento.', '',
      '👉 Pagar agora: {link}', '',
      'Se já pagou, desconsidere esta mensagem. 😉']) },
  { key: 'wa_atraso', channel: 'whatsapp', group: 'Antes do vencimento', label: 'Mensalidade atrasada', hint: 'No dia seguinte ao vencimento, se não pagou.',
    on: true, vars: ['nome', 'plano', 'valor', 'vencimento', 'formas_pagamento', 'link'], body: w([
      'Olá, {nome}.', '',
      'Não identificamos o pagamento da mensalidade do *{plano}* ({valor}), que venceu em {vencimento}.', '',
      'Você pode pagar agora com {formas_pagamento}:',
      '👉 {link}', '',
      'Se já pagou, desconsidere. Qualquer dúvida, é só responder aqui.']) },

  { key: 'wa_auto_lembrete', channel: 'whatsapp', group: 'Renovação automática', label: 'Aviso de cobrança no cartão', hint: 'Alguns dias antes da cobrança automática.',
    on: true, vars: ['nome', 'plano', 'valor', 'vencimento', 'cartao', 'link'], body: w([
      'Olá, {nome}! 👋', '',
      'No dia *{vencimento}* vamos cobrar a mensalidade do *{plano}* ({valor}) no seu cartão {cartao}.', '',
      'É automático: você não precisa fazer nada. 😉', '',
      'Para trocar o cartão ou ver seus pagamentos: {link}']) },
  { key: 'wa_auto_hoje', channel: 'whatsapp', group: 'Renovação automática', label: 'Cobrança no cartão hoje', hint: 'No dia da cobrança, se o aviso ainda não tinha saído.',
    on: true, vars: ['nome', 'plano', 'valor', 'vencimento', 'cartao', 'link'], body: w([
      'Olá, {nome}! 👋', '',
      'Hoje ({vencimento}) cobramos a mensalidade do *{plano}* ({valor}) no seu cartão {cartao}.', '',
      'É automático: você não precisa fazer nada. 😉', '',
      'Para trocar o cartão ou ver seus pagamentos: {link}']) },
  { key: 'wa_auto_recusada', channel: 'whatsapp', group: 'Renovação automática', label: 'Cobrança automática recusada', hint: '2 dias depois do vencimento, se o cartão não passou.',
    on: true, vars: ['nome', 'plano', 'valor', 'cartao', 'link'], body: w([
      'Olá, {nome}.', '',
      'A cobrança automática da mensalidade do *{plano}* ({valor}) no seu cartão {cartao} *não foi aprovada*.',
      'Pode ser limite, cartão vencido ou bloqueado.', '',
      'Para não perder o acesso, atualize o cartão aqui:',
      '👉 {link}', '',
      'Qualquer dúvida, é só responder esta mensagem.']) },

  { key: 'wa_retencao', channel: 'whatsapp', group: 'Cancelamento', label: 'Pergunta: quer continuar?', hint: 'Alguns dias antes do fim do acesso de quem cancelou. Ele responde SIM ou NÃO.',
    on: true, vars: ['nome', 'plano', 'acesso_ate'], body: w([
      'Oi, {nome}! 👋', '',
      'Você cancelou o plano *{plano}*, e seu acesso vai até *{acesso_ate}*.', '',
      '*Você quer continuar usando?*',
      'Responda esta mensagem com:',
      '👉 *SIM* — para continuar',
      '👉 *NÃO* — para encerrar no dia {acesso_ate}']) },
  { key: 'wa_retencao_sim_auto', channel: 'whatsapp', group: 'Cancelamento', label: 'Respondeu SIM (renovação automática)', hint: 'Resposta automática quando ele decide continuar e tem cartão cadastrado.',
    on: true, vars: ['nome', 'plano', 'valor', 'acesso_ate', 'cartao'], body: w([
      'Que ótimo, {nome}! 🎉 Seu plano *{plano}* continua.', '',
      'A renovação automática voltou: em *{acesso_ate}* cobramos {valor} no seu cartão {cartao}. Você não precisa fazer nada.']) },
  { key: 'wa_retencao_sim', channel: 'whatsapp', group: 'Cancelamento', label: 'Respondeu SIM (paga por Pix)', hint: 'Resposta automática quando ele decide continuar e paga por Pix.',
    on: true, vars: ['nome', 'plano', 'valor', 'acesso_ate', 'formas_pagamento', 'link'], body: w([
      'Que ótimo, {nome}! 🎉 Seu plano *{plano}* continua.', '',
      'A próxima mensalidade ({valor}) vence em *{acesso_ate}*.',
      'Você pode pagar com {formas_pagamento} aqui:',
      '👉 {link}']) },
  { key: 'wa_retencao_nao', channel: 'whatsapp', group: 'Cancelamento', label: 'Respondeu NÃO', hint: 'Resposta automática quando ele confirma que não vai continuar.',
    on: true, vars: ['nome', 'acesso_ate'], body: w([
      'Tudo bem, {nome}. Seu acesso continua até *{acesso_ate}* e depois o plano será encerrado.', '',
      'Obrigado por ter sido nosso assinante! Se quiser voltar, é só assinar de novo pelo site. 💛']) },

  { key: 'wa_checkout_1h', channel: 'whatsapp', group: 'Não concluiu o pagamento', label: '1 hora depois', hint: 'Escolheu o plano e não pagou em 1 hora.',
    on: true, vars: ['nome', 'plano', 'valor', 'formas_pagamento', 'link'], body: w([
      'Oi, {nome}! 👋', '',
      'Vi que você escolheu o plano *{plano}* ({valor}/mês), mas o pagamento ainda não foi concluído.', '',
      'Você pode pagar com {formas_pagamento} aqui:',
      '👉 {link}', '',
      'Precisa de ajuda? É só responder esta mensagem.']) },
  { key: 'wa_checkout_24h', channel: 'whatsapp', group: 'Não concluiu o pagamento', label: '24 horas depois', hint: 'Último lembrete, 24 horas depois de escolher o plano.',
    on: true, vars: ['nome', 'plano', 'valor', 'formas_pagamento', 'link'], body: w([
      'Oi, {nome}! 😊', '',
      'Sua assinatura do *{plano}* ({valor}/mês) ainda está esperando o pagamento para ser ativada.', '',
      'É rapidinho, com {formas_pagamento}:',
      '👉 {link}', '',
      'Se tiver qualquer dúvida ou dificuldade para pagar, é só responder esta mensagem que a gente te ajuda.']) },
];

const BY_KEY = new Map(CATALOG.map((t) => [t.key, t]));
const tplOf = (key) => BY_KEY.get(String(key)) || null;
const LIMITS = { title: 80, body: 2000 };

let cache = null;
let cacheAt = 0;
async function stored() {
  if (cache && Date.now() - cacheAt < 15_000) return cache;
  let row;
  try {
    row = await get('SELECT value FROM settings WHERE key = ?', [STORE_KEY]);
  } catch (err) {
    // Banco fora por um instante: usa a última leitura boa; sem ela, o erro sobe e a mensagem não sai
    // (nunca tratar a falha como "nada personalizado": religaria mensagens desligadas)
    if (cache) return cache;
    throw err;
  }
  let data = {};
  try { data = row?.value ? JSON.parse(row.value) : {}; } catch { /* inválido: usa os padrões */ }
  cache = data && typeof data === 'object' ? data : {};
  cacheAt = Date.now();
  return cache;
}

/** Modelo atual (padrão + o que o admin mudou). */
export async function getTemplate(key) {
  const t = tplOf(key);
  if (!t) throw new Error(`modelo desconhecido: ${key}`);
  const all = await stored();
  const s = Object.hasOwn(all, t.key) ? all[t.key] : {};
  return {
    on: typeof s.on === 'boolean' ? s.on : t.on,
    title: t.channel === 'push' ? (typeof s.title === 'string' && s.title.trim() ? s.title : t.title) : undefined,
    body: typeof s.body === 'string' && s.body.trim() ? s.body : t.body,
    custom: Boolean(s.title || s.body),
  };
}

/** Lista para o painel: catálogo + valores atuais + padrões. */
export async function listTemplates(channel) {
  const out = [];
  for (const t of CATALOG.filter((x) => !channel || x.channel === channel)) {
    const cur = await getTemplate(t.key);
    out.push({
      key: t.key, channel: t.channel, group: t.group, label: t.label, hint: t.hint,
      vars: t.vars.map((v) => ({ name: v, label: VARS[v].label, sample: VARS[v].sample })),
      on: cur.on, title: cur.title, body: cur.body, custom: cur.custom,
      default_title: t.title, default_body: t.body, default_on: t.on,
    });
  }
  return out;
}

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

// Gravações uma de cada vez e sempre a partir do que está no banco (não do cache),
// para duas alterações seguidas não se sobrescreverem.
let writing = Promise.resolve();
function serialWrite(fn) {
  const p = writing.then(fn, fn);
  writing = p.catch(() => {});
  return p;
}
async function freshStored() {
  const row = await get('SELECT value FROM settings WHERE key = ?', [STORE_KEY]);
  let data = {};
  try { data = row?.value ? JSON.parse(row.value) : {}; } catch { /* inválido: recomeça */ }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
async function persist(all) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [STORE_KEY, JSON.stringify(all)]);
  cache = all; cacheAt = Date.now();
}
/** Variável usada no texto que não existe neste modelo (ou undefined). */
const unknownVar = (t, text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((n) => !t.vars.includes(n));

export function saveTemplate(key, { on, title, body } = {}) {
  return serialWrite(async () => {
  const t = tplOf(key);
  if (!t) throw badRequest('Modelo não encontrado.');
  const all = await freshStored();
  const cur = { ...(Object.hasOwn(all, t.key) ? all[t.key] : {}) };
  if (on !== undefined) cur.on = Boolean(on);
  if (title !== undefined && t.channel === 'push') {
    const v = String(title).trim();
    if (v.length > LIMITS.title) throw badRequest(`O título pode ter no máximo ${LIMITS.title} caracteres.`);
    const ut = unknownVar(t, v);
    if (ut) throw badRequest(`A variável {${ut}} não existe neste modelo. Use as variáveis da lista.`);
    if (v && v !== t.title) cur.title = v; else delete cur.title;
  }
  if (body !== undefined) {
    const v = String(body).replace(/\r\n/g, '\n').trim();
    if (!v) throw badRequest('A mensagem não pode ficar vazia.');
    if (v.length > LIMITS.body) throw badRequest(`A mensagem pode ter no máximo ${LIMITS.body} caracteres.`);
    const ub = unknownVar(t, v);
    if (ub) throw badRequest(`A variável {${ub}} não existe neste modelo. Use as variáveis da lista.`);
    if (v !== t.body) cur.body = v; else delete cur.body;
  }
  if (Object.keys(cur).length) all[t.key] = cur; else delete all[t.key];
  await persist(all);
  return (await listTemplates()).find((x) => x.key === t.key);
  });
}

export function resetTemplate(key) {
  return serialWrite(async () => {
    const t = tplOf(key);
    if (!t) throw badRequest('Modelo não encontrado.');
    const all = await freshStored();
    delete all[t.key];
    await persist(all);
    return (await listTemplates()).find((x) => x.key === t.key);
  });
}

/** Troca as variáveis. Linha com {link} vazio some; espaços sobrando são limpos. */
export function fill(text, vars) {
  const lines = String(text || '').split('\n');
  // Sem link: some a linha do link e a frase que o apresenta (a linha anterior terminada em ":")
  const kept = [];
  for (const line of lines) {
    if (/\{link\}/.test(line) && !vars.link) {
      if (kept.length && /:\s*$/.test(kept[kept.length - 1])) kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept
    .map((line) => line.replace(/\{(\w+)\}/g, (m, name) => (!Object.hasOwn(vars, name) || vars[name] === undefined || vars[name] === null ? '' : String(vars[name])))
      .replace(/ {2,}/g, ' ').replace(/ +([.,!?;:)])/g, '$1').replace(/\( +/g, '(').replace(/ · $/, '').replace(/^ · /, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Mensagem pronta para enviar, ou null se o modelo estiver desligado.
 * Para push: { title, body }. Para WhatsApp: o texto.
 */
export async function render(key, vars) {
  const t = tplOf(key);
  const cur = await getTemplate(key);
  if (!cur.on) return null;
  if (t.channel === 'push') return { title: fill(cur.title, vars) || t.title, body: fill(cur.body, vars), url: t.url };
  return fill(cur.body, vars);
}

/** Valores de exemplo (pré-visualização e envio de teste). */
export function sampleVars() {
  return Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, v.sample]));
}

export function templateInfo(key) {
  return tplOf(key);
}
