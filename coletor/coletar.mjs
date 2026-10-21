// Coletor de cotações do painel agrícola.
// Busca cada fonte pública, normaliza e grava um único data.json.
// Uma fonte com erro nunca derruba as outras: o item mantém o último valor
// conhecido (vindo do data.json anterior) e ganha o campo "erroDesde".
//
// Uso: node coletar.mjs --out ../data.json [--prev <url ou arquivo do data.json anterior>]

import { readFile, writeFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const OUT = args.out || 'data.json';
const PREV = args.prev || OUT;
const AGORA = new Date().toISOString();

// ---------- utilidades ----------

async function baixar(url, { binario = false, tentativas = 3 } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
      return binario ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) {
      ultimoErro = e;
      await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
    }
  }
  throw ultimoErro;
}

const baixarJson = async (url) => JSON.parse(await baixar(url));

// "1.565,19" -> 1565.19 ; "-0,24%" -> -0.24 ; "s/ cotação" -> null
function numBR(txt) {
  if (txt == null) return null;
  if (typeof txt === 'number') return txt;
  const limpo = String(txt).replace(/[^\d,.\-+]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
}

// "19/10/2026" -> "2026-10-19"
const dataBR = (txt) => {
  const m = String(txt).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const textoPuro = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
  .replace(/\s+/g, ' ')
  .trim();

function linhasTabela(htmlTabela) {
  return [...htmlTabela.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) =>
    [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textoPuro(c[1])));
}

const pct = (atual, anterior) => (atual != null && anterior ? (atual / anterior - 1) * 100 : null);

// Junta o histórico novo com o antigo, sem duplicar datas, e corta no tamanho máximo.
function juntarHist(antigo = [], novo = [], max = 60) {
  const mapa = new Map(antigo);
  for (const [d, v] of novo) if (v != null) mapa.set(d, v);
  return [...mapa.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-max);
}

// Variação contra o ponto anterior do histórico (útil quando a fonte não traz a variação).
function varPeloHist(hist, data) {
  const idx = hist.findIndex(([d]) => d === data);
  if (idx < 1) return null;
  return pct(hist[idx][1], hist[idx - 1][1]);
}

// ---------- fontes ----------

// CEPEA/ESALQ: cada página tem uma ou mais tabelas, cada uma precedida pelo título do indicador.
async function cepea(slug) {
  if (process.env.SIMULAR_BLOQUEIO_CEPEA) throw new Error('bloqueio simulado');
  const html = await baixar(`https://www.cepea.org.br/br/indicador/${slug}.aspx`);
  const tabelas = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const antes = textoPuro(html.slice(Math.max(0, m.index - 1500), m.index));
    const titulos = antes.match(/(INDICADOR|PREÇO MÉDIO)[^.]*?(CEPEA\/ESALQ)[^a-z]*/g) || [];
    const titulo = (titulos[titulos.length - 1] || '').trim();
    const linhas = linhasTabela(m[0])
      .filter((l) => dataBR(l[0]))
      .map((l) => ({ data: dataBR(l[0]), valor: numBR(l[1]), varDia: numBR(l[2]), varMes: numBR(l[3]) }));
    if (linhas.length) tabelas.push({ titulo, linhas });
  }
  if (!tabelas.length) throw new Error(`CEPEA ${slug}: nenhuma tabela encontrada`);
  return tabelas;
}

// Reserva: o CEPEA bloqueia acessos vindos de datacenters (como os servidores do GitHub).
// O Notícias Agrícolas republica os mesmos indicadores, uma tabela por dia.
const CEPEA_NA = {
  'soja:PARANAGUÁ': 'soja/soja-indicador-cepea-esalq-porto-paranagua',
  'soja:PARANÁ': 'soja/indicador-cepea-esalq-soja-parana',
  'milho:': 'milho/indicador-cepea-esalq-milho',
  'trigo:PARANÁ': 'trigo/preco-medio-do-trigo-cepea-esalq',
};
async function cepeaViaNA(slug, chave) {
  const caminho = CEPEA_NA[`${slug}:${chave}`];
  if (!caminho) throw new Error(`sem reserva para ${slug} ${chave}`);
  const html = await baixar(`https://www.noticiasagricolas.com.br/cotacoes/${caminho}`);
  const linhas = [];
  for (const m of html.matchAll(/<table class="cot-fisicas"[\s\S]*?<\/table>/gi)) {
    for (const l of linhasTabela(m[0])) {
      if (!dataBR(l[0]) || numBR(l[l.length >= 4 ? 2 : 1]) == null) continue;
      // Trigo traz uma linha por região: Data | Região | R$/t | Variação.
      if (l.length >= 4) { if (!/paran/i.test(l[1])) continue; linhas.push({ data: dataBR(l[0]), valor: numBR(l[2]), varDia: numBR(l[3]), varMes: null }); }
      else linhas.push({ data: dataBR(l[0]), valor: numBR(l[1]), varDia: numBR(l[2]), varMes: null });
    }
  }
  if (!linhas.length) throw new Error(`Notícias Agrícolas ${caminho}: sem dados`);
  linhas.sort((a, b) => (a.data < b.data ? 1 : -1));
  return { titulo: chave, linhas, fonte: 'CEPEA/ESALQ via Notícias Agrícolas' };
}

// Tenta o CEPEA; se falhar, usa a reserva. chave '' = primeira tabela da página.
async function indicadorCepea(slug, chave) {
  try {
    const t = await cepea(slug);
    return chave ? acharTabela(t, chave) : t[0];
  } catch (e) {
    console.error(`  CEPEA ${slug} indisponível (${e.message}); usando Notícias Agrícolas`);
    return cepeaViaNA(slug, chave);
  }
}

function itemCepea(tabela, extra) {
  const [ult] = tabela.linhas;
  return {
    valor: ult.valor,
    data: ult.data,
    var: { pct: ult.varDia, periodo: 'dia' },
    varMes: ult.varMes,
    freq: 'diario',
    fonte: tabela.fonte || 'CEPEA/ESALQ',
    hist: tabela.linhas.map((l) => [l.data, l.valor]).reverse(),
    ...extra,
  };
}

const acharTabela = (tabelas, chave) => {
  const t = tabelas.find((x) => x.titulo.toUpperCase().includes(chave));
  if (!t) throw new Error(`CEPEA: tabela "${chave}" não encontrada`);
  return t;
};

// Bolsa de Chicago via Yahoo Finance (contrato contínuo = vencimento mais próximo). Preço em centavos de US$.
async function cbot(simbolo, extra) {
  const j = await baixarJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=2mo&interval=1d`);
  const r = j.chart.result[0];
  const meta = r.meta;
  const closes = r.indicators.quote[0].close;
  const hist = r.timestamp
    .map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), closes[i] != null ? closes[i] / 100 : null])
    .filter(([, v]) => v != null);
  const valor = meta.regularMarketPrice / 100;
  const quando = new Date(meta.regularMarketTime * 1000);
  const diaPregao = quando.toISOString().slice(0, 10);
  const anteriores = hist.filter(([d]) => d < diaPregao);
  const anterior = anteriores.length ? anteriores[anteriores.length - 1][1] : null;
  return {
    valor,
    data: quando.toISOString(),
    var: { pct: pct(valor, anterior), periodo: 'dia' },
    freq: 'live',
    atrasoMin: 15,
    fonte: 'CBOT via Yahoo Finance',
    hist: hist.slice(-30),
    ...extra,
  };
}

// B3 (soja FOB Santos, US$/saca) via página pública do Notícias Agrícolas.
async function b3Soja() {
  const html = await baixar('https://www.noticiasagricolas.com.br/cotacoes/soja/soja-b3-pregao-regular');
  const tabela = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0];
  if (!tabela) throw new Error('B3: tabela não encontrada');
  const linha = linhasTabela(tabela).find((l) => /\d{4}/.test(l[0]) && numBR(l[1]) != null);
  const data = dataBR((textoPuro(html).match(/Fechamento:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1]);
  return {
    nome: 'Soja B3',
    contrato: linha[0],
    valor: numBR(linha[1]),
    unidade: 'US$/sc',
    data,
    var: { pct: numBR(linha[2]), periodo: 'dia' },
    freq: 'diario',
    fonte: 'B3 via Notícias Agrícolas',
    hist: [[data, numBR(linha[1])]],
  };
}

// SEAB/DERAL — SIMA: cotação diária de compra pelos atacadistas, por núcleo regional (planilha .xlsx).
async function sima(qtd = 2) {
  const lista = await baixar('https://www.agricultura.pr.gov.br/Cotacao-Diaria-SIMA');
  const ids = [...lista.matchAll(/Cotacao-Diaria-SIMA-(\d+)/g)].map((m) => +m[1]);
  if (!ids.length) throw new Error('SIMA: lista de cotações vazia');
  // As duas cotações mais recentes, para já haver variação diária na primeira execução.
  const ultimos = [...new Set(ids)].sort((a, b) => b - a).slice(0, qtd);
  const dias = [];
  for (const id of ultimos) {
    try { dias.push(await simaDia(id)); } catch (e) { if (!dias.length && id === ultimos[ultimos.length - 1]) throw e; }
  }
  if (!dias.length) throw new Error('SIMA: nenhuma planilha lida');
  return dias.sort((a, b) => (a.data < b.data ? 1 : -1));
}

async function simaDia(id) {
  const pagina = await baixar(`https://www.agricultura.pr.gov.br/Pagina/Cotacao-Diaria-SIMA-${id}`);
  const link = (pagina.match(/href="([^"]+\.xlsx)"/i) || [])[1];
  if (!link) throw new Error('SIMA: planilha não encontrada');
  const wb = XLSX.read(await baixar(new URL(link, 'https://www.agricultura.pr.gov.br').href, { binario: true }));
  const nomeAba = wb.SheetNames.find((n) => /\d{2}-\d{2}-\d{4}/.test(n)) || wb.SheetNames[wb.SheetNames.length - 1];
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });

  let data = null;
  for (const l of linhas.slice(0, 5)) for (const c of l) if (!data && dataBR(c)) data = dataBR(c);
  const cab = linhas.find((l) => l.some((c) => typeof c === 'string' && c.trim().toUpperCase() === 'MARINGÁ'));
  if (!cab) throw new Error('SIMA: coluna Maringá não encontrada');
  const col = cab.findIndex((c) => typeof c === 'string' && c.trim().toUpperCase() === 'MARINGÁ');

  // Cada produto ocupa 3 linhas (MIN, M_C, MÁX). Usamos M_C, o preço mais comum do dia.
  const preco = (inicioNome) => {
    const i = linhas.findIndex((l) => typeof l[0] === 'string' && l[0].trim().toLowerCase().startsWith(inicioNome));
    if (i < 0) return null;
    const lmc = linhas.slice(i, i + 3).find((l) => l.some((c) => c === 'M_C'));
    // A coluna do município fica alinhada com o cabeçalho, mas a linha M_C não tem o nome do produto;
    // a posição do valor é a mesma do cabeçalho.
    const v = lmc ? lmc[col] : null;
    return typeof v === 'number' ? v : null;
  };
  if (!data) throw new Error('SIMA: data não encontrada');
  return { data, soja: preco('soja'), milho: preco('milho'), trigo: preco('trigo') };
}

// ANP — levantamento semanal de preços (resumo .xlsx). Diesel S10 no Paraná e em Maringá.
async function anp(qtd = 2) {
  const html = await baixar('https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas');
  const links = [...new Set([...html.matchAll(/href="([^"]*resumo_semanal_lpc_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.xlsx)"/g)].map((m) => m[1]))]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, qtd);
  if (!links.length) throw new Error('ANP: planilha não encontrada');

  const semanas = [];
  for (const link of links) {
    const wb = XLSX.read(await baixar(link, { binario: true }), { cellDates: true });
    const ler = (aba, campoLocal, local) => {
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: null });
      const ic = linhas.findIndex((l) => l.includes('PRODUTO'));
      const cab = linhas[ic];
      const iL = cab.indexOf(campoLocal), iP = cab.indexOf('PRODUTO'), iV = cab.indexOf('PREÇO MÉDIO REVENDA'), iF = cab.indexOf('DATA FINAL');
      const l = linhas.slice(ic + 1).find((x) => x[iL] === local && x[iP] === 'OLEO DIESEL S10');
      return l ? { valor: l[iV], fim: new Date(l[iF]).toISOString().slice(0, 10) } : null;
    };
    semanas.push({ pr: ler('ESTADOS', 'ESTADOS', 'PARANA'), maringa: ler('MUNICIPIOS', 'MUNICÍPIO', 'MARINGA') });
  }
  return semanas;
}

// Banco Mundial — "Pink Sheet" mensal. Ureia, DAP e cloreto de potássio em US$/t.
async function bancoMundial() {
  const html = await baixar('https://www.worldbank.org/en/research/commodity-markets');
  const link = (html.match(/href="([^"]+CMO-Historical-Data-Monthly\.xlsx)"/) || [])[1];
  if (!link) throw new Error('Banco Mundial: planilha mensal não encontrada');
  const wb = XLSX.read(await baixar(link, { binario: true }));
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets['Monthly Prices'], { header: 1, defval: null });
  const cab = linhas.find((l) => l.some((c) => typeof c === 'string' && c.trim() === 'Urea'));
  const col = (nome) => cab.findIndex((c) => typeof c === 'string' && c.trim().toLowerCase().startsWith(nome));
  const dados = linhas.filter((l) => typeof l[0] === 'string' && /^\d{4}M\d{2}$/.test(l[0]));
  const serie = (c) => dados
    .filter((l) => typeof l[c] === 'number')
    .slice(-13)
    .map((l) => [`${l[0].slice(0, 4)}-${l[0].slice(5)}-01`, l[c]]);
  return { ureia: serie(col('urea')), dap: serie(col('dap')), kcl: serie(col('potassium chloride')) };
}

// AwesomeAPI — dólar comercial (o painel também consulta direto do navegador; isto é a reserva).
async function dolar() {
  // O histórico é opcional: a AwesomeAPI limita servidores compartilhados (HTTP 429) e o painel
  // também busca o dólar direto da TV.
  const [ult, dias] = await Promise.all([
    baixarJson('https://economia.awesomeapi.com.br/json/last/USD-BRL'),
    baixarJson('https://economia.awesomeapi.com.br/json/daily/USD-BRL/30').catch(() => []),
  ]);
  const u = ult.USDBRL;
  const hist = dias.map((d) => [new Date(d.timestamp * 1000).toISOString().slice(0, 10), parseFloat(d.bid)]).reverse();
  return {
    nome: 'Dólar comercial',
    valor: parseFloat(u.bid),
    unidade: 'R$',
    data: new Date(u.timestamp * 1000).toISOString(),
    var: { pct: parseFloat(u.pctChange), periodo: 'dia' },
    freq: 'live',
    atrasoMin: 0,
    fonte: 'AwesomeAPI',
    hist: juntarHist([], hist, 30),
  };
}

// Notícias do agro: manchetes dos feeds RSS públicos (só título, fonte, horário e link).
const FEEDS = [
  ['g1 Agro', 'https://g1.globo.com/rss/g1/economia/agronegocios/'],
  ['Canal Rural', 'https://www.canalrural.com.br/feed/'],
];
async function noticias() {
  const todas = [];
  const falhas = [];
  await Promise.all(FEEDS.map(async ([fonte, url]) => {
    try {
      const xml = await baixar(url);
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const tag = (t) => {
          const r = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
          return r ? textoPuro(r[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
        };
        const data = new Date(tag('pubDate'));
        const titulo = tag('title');
        if (titulo && !isNaN(data)) todas.push({ titulo, fonte, data: data.toISOString(), link: tag('link') });
      }
    } catch (e) { falhas.push(`${fonte}: ${e.message}`); }
  }));
  if (!todas.length) throw new Error(falhas.join('; ') || 'nenhuma notícia');
  const vistos = new Set();
  const porFonte = {};
  return todas
    .sort((x, y) => (x.data < y.data ? 1 : -1))
    .filter((n) => {
      const chave = n.titulo.toLowerCase().slice(0, 60);
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      porFonte[n.fonte] = (porFonte[n.fonte] || 0) + 1;
      return porFonte[n.fonte] <= 5; // equilíbrio entre as fontes
    })
    .slice(0, 8);
}

// INMET — alertas meteorológicos oficiais ativos para o município (código IBGE).
const MUNICIPIOS_IBGE = ['4115200']; // Maringá-PR (os polígonos do INMET cobrem também Paiçandu)
async function alertasInmet() {
  const j = await baixarJson('https://apiprevmet3.inmet.gov.br/avisos/ativos');
  const agora = Date.now();
  const lista = [].concat(j.hoje || [], j.futuro || [])
    .filter((a) => String(a.geocodes || '').split(',').some((g) => MUNICIPIOS_IBGE.includes(g.trim())))
    .map((a) => ({
      evento: a.descricao,
      severidade: a.severidade,
      cor: a.aviso_cor,
      // "2026-10-21 15:00" é horário de Brasília
      inicio: `${String(a.inicio).replace(' ', 'T')}:00-03:00`,
      fim: `${String(a.fim).replace(' ', 'T')}:00-03:00`,
      riscos: a.riscos,
    }))
    .filter((a) => new Date(a.fim).getTime() > agora && !isNaN(new Date(a.inicio)))
    .sort((x, y) => (x.inicio < y.inicio ? -1 : 1));
  // Remove repetidos (mesmo evento no mesmo intervalo).
  const vistos = new Set();
  return lista.filter((a) => { const k = a.evento + a.inicio + a.fim; if (vistos.has(k)) return false; vistos.add(k); return true; });
}

// Satélite GOES-East (NASA GIBS): descobre o quadro mais recente já publicado
// (o GIBS publica com ~1 h de atraso; quadros ainda não processados vêm em branco, com poucos bytes).
// A camada GeoColor (cores reais) às vezes trava na origem por horas (NASA e NOAA juntas); nesse caso
// cai para o infravermelho (banda 13), que sai de outro processamento e segue atualizado.
const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0' +
  '&STYLES=&CRS=EPSG:4326&BBOX=-27.4,-55.6,-21.9,-47.6&FORMAT=image/jpeg';
const CAMADAS_SAT = ['GOES-East_ABI_GeoColor', 'GOES-East_ABI_Band13_Clean_Infrared'];
async function satelite() {
  const passo = 10 * 60 * 1000;
  for (const camada of CAMADAS_SAT) {
    let t = Math.floor((Date.now() - 40 * 60 * 1000) / passo) * passo;
    for (let i = 0; i < 18; i++, t -= passo) {
      const iso = new Date(t).toISOString().slice(0, 19) + 'Z';
      const img = await baixar(`${GIBS}&LAYERS=${camada}&WIDTH=220&HEIGHT=152&TIME=${iso}`, { binario: true, tentativas: 1 });
      if (img.length > 3000) {
        // 7 quadros de 20 em 20 min: 2 horas de movimento das nuvens.
        const quadros = [];
        for (let k = 6; k >= 0; k--) quadros.push(new Date(t - k * 2 * passo).toISOString().slice(0, 19) + 'Z');
        const r = { camada, quadros };
        if (camada !== CAMADAS_SAT[0]) {
          r.aviso = 'A imagem em cores reais (GeoColor) está parada na origem (NASA/NOAA). Mostrando o infravermelho, que segue atualizado.';
          console.error(`⚠ satélite: GeoColor sem quadros novos; usando ${camada}`);
        }
        return r;
      }
    }
  }
  throw new Error('nenhum quadro de satélite disponível');
}

// ---------- montagem ----------

async function carregarAnterior() {
  try {
    const txt = /^https?:/.test(PREV) ? await baixar(`${PREV}?t=${Date.now()}`, { tentativas: 1 }) : await readFile(PREV, 'utf8');
    return JSON.parse(txt);
  } catch {
    return { itens: {} };
  }
}

async function main() {
  const anterior = await carregarAnterior();
  const itens = {};
  const erros = {};

  // Cada tarefa devolve { id: item } ou lança erro; os ids listados ficam com o valor antigo em caso de falha.
  const tarefas = [
    [['soja_paranagua', 'soja_parana'], async () => {
      const [porto, interior] = await Promise.all([indicadorCepea('soja', 'PARANAGUÁ'), indicadorCepea('soja', 'PARANÁ')]);
      return {
        soja_paranagua: itemCepea(porto, { nome: 'Soja Paranaguá', unidade: 'R$/sc' }),
        soja_parana: itemCepea(interior, { nome: 'Soja Paraná', unidade: 'R$/sc' }),
      };
    }],
    [['milho_cepea'], async () => ({ milho_cepea: itemCepea(await indicadorCepea('milho', ''), { nome: 'Milho Campinas', unidade: 'R$/sc' }) })],
    [['trigo_cepea'], async () => ({ trigo_cepea: itemCepea(await indicadorCepea('trigo', 'PARANÁ'), { nome: 'Trigo Paraná', unidade: 'R$/t' }) })],
    [['soja_cbot'], async () => ({ soja_cbot: await cbot('ZS=F', { nome: 'Soja Chicago', unidade: 'US$/bu' }) })],
    [['milho_cbot'], async () => ({ milho_cbot: await cbot('ZC=F', { nome: 'Milho Chicago', unidade: 'US$/bu' }) })],
    [['trigo_cbot'], async () => ({ trigo_cbot: await cbot('ZW=F', { nome: 'Trigo Chicago', unidade: 'US$/bu' }) })],
    [['soja_b3'], async () => ({ soja_b3: await b3Soja() })],
    [['usd'], async () => ({ usd: await dolar() })],
    [['maringa_soja', 'maringa_milho', 'maringa_trigo'], async () => {
      // Na primeira execução (histórico curto) busca mais dias para o gráfico já nascer preenchido.
      const curto = ((anterior.itens.maringa_soja || {}).hist || []).length < 10;
      const dias = await sima(curto ? 15 : 2);
      const s = dias[0];
      const item = (prod, nome) => {
        const id = `maringa_${prod}`;
        const hist = juntarHist((anterior.itens[id] || {}).hist, dias.map((d) => [d.data, d[prod]]), 60);
        return {
          nome, valor: s[prod], unidade: 'R$/sc', data: s.data,
          var: { pct: varPeloHist(hist, s.data), periodo: 'dia' },
          freq: 'diario', fonte: 'SEAB/DERAL (SIMA) · núcleo Maringá', hist,
        };
      };
      return { maringa_soja: item('soja', 'Soja Maringá'), maringa_milho: item('milho', 'Milho Maringá'), maringa_trigo: item('trigo', 'Trigo Maringá') };
    }],
    [['diesel_pr', 'diesel_maringa'], async () => {
      const curto = ((anterior.itens.diesel_pr || {}).hist || []).length < 8;
      const semanas = await anp(curto ? 12 : 2);
      const [atual, ant] = semanas;
      const item = (chave, id, nome) => ({
        nome, valor: atual[chave].valor, unidade: 'R$/L', data: atual[chave].fim,
        var: { pct: ant && ant[chave] ? pct(atual[chave].valor, ant[chave].valor) : null, periodo: 'semana' },
        freq: 'semanal', fonte: 'ANP · levantamento semanal',
        hist: juntarHist((anterior.itens[id] || {}).hist, semanas.filter((w) => w[chave]).map((w) => [w[chave].fim, w[chave].valor]), 26),
      });
      return { diesel_pr: item('pr', 'diesel_pr', 'Diesel S10 Paraná'), diesel_maringa: item('maringa', 'diesel_maringa', 'Diesel S10 Maringá') };
    }],
    [['ureia', 'dap', 'kcl'], async () => {
      const wb = await bancoMundial();
      const item = (serie, nome) => {
        const [d, v] = serie[serie.length - 1];
        return {
          nome, valor: v, unidade: 'US$/t', data: d,
          var: { pct: pct(v, serie[serie.length - 2][1]), periodo: 'mês' },
          freq: 'mensal', fonte: 'Banco Mundial (Pink Sheet)', hist: serie,
        };
      };
      return { ureia: item(wb.ureia, 'Ureia'), dap: item(wb.dap, 'DAP'), kcl: item(wb.kcl, 'Cloreto de potássio') };
    }],
  ];

  await Promise.all(tarefas.map(async ([ids, fn]) => {
    try {
      const novos = await fn();
      for (const id of ids) {
        const n = novos[id];
        if (!n || n.valor == null) throw new Error(`${id}: valor vazio`);
        const velho = anterior.itens[id] || {};
        itens[id] = { ...n, hist: juntarHist(velho.hist, n.hist, n.freq === 'mensal' ? 13 : 60), coletadoEm: AGORA };
      }
    } catch (e) {
      for (const id of ids) {
        erros[id] = String(e.message || e);
        const velho = anterior.itens[id];
        if (velho) itens[id] = { ...velho, erroDesde: velho.erroDesde || AGORA, erro: erros[id] };
      }
      console.error(`✗ ${ids.join(', ')}: ${e.message || e}`);
    }
  }));

  let listaNoticias = anterior.noticias || [];
  try { listaNoticias = await noticias(); } catch (e) { console.error(`✗ notícias: ${e.message}`); }

  // Alertas: se o INMET falhar, mantém os anteriores que ainda não venceram.
  let alertas = (anterior.alertas || []).filter((a) => new Date(a.fim).getTime() > Date.now());
  let alertasOk = false;
  try { alertas = await alertasInmet(); alertasOk = true; } catch (e) { console.error(`✗ alertas INMET: ${e.message}`); }

  let sat = anterior.satelite || null;
  try { sat = await satelite(); } catch (e) { console.error(`✗ satélite: ${e.message}`); }

  const saida = {
    versao: 1, geradoEm: AGORA, itens, noticias: listaNoticias,
    alertas, alertasColetadoEm: alertasOk ? AGORA : anterior.alertasColetadoEm || null,
    satelite: sat,
  };
  await writeFile(OUT, JSON.stringify(saida));
  const ok = Object.keys(itens).filter((id) => !itens[id].erroDesde).length;
  console.log(`data.json gravado: ${ok} itens atualizados, ${Object.keys(erros).length} com erro.`);
  console.log(`  notícias: ${listaNoticias.length} · alertas INMET: ${alertas.length}`);
  for (const [id, it] of Object.entries(itens)) console.log(`  ${id.padEnd(15)} ${String(it.valor).padEnd(10)} ${it.unidade.padEnd(7)} ${it.data}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
