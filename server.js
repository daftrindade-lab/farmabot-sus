const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── CORS — permite chamadas do Netlify ────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CLAUDE_KEY    = process.env.CLAUDE_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const INSTANCE      = process.env.INSTANCE_NAME || 'farmabot-trindade';
const PORT          = process.env.PORT || 3000;

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da UBS de Trindade-GO, criada pela farmacêutica Vanessa, Diretora de Assistência Farmacêutica do município.

PERFIL DOS PACIENTES: Maioria idosos com hipertensão arterial (HAS) e diabetes mellitus tipo 2 (DM2), polimedicados, com baixa escolaridade.

SUAS COMPETÊNCIAS:
1. ADESÃO AO TRATAMENTO: Identificar sinais de abandono, motivar, explicar a importância de cada medicamento de forma simples.
2. ORIENTAÇÃO DE USO: Horário correto, relação com alimentos, armazenamento, o que fazer se esquecer uma dose.
3. EFEITOS COLATERAIS: Explicar os mais comuns dos medicamentos do SUS para HAS e DM.
4. TRIAGEM DE RISCO: Se o paciente relatar sintomas graves (dor no peito, falta de ar, pressão muito alta, hipoglicemia grave), SEMPRE orientar a buscar o SAMU 192 ou UPA imediatamente.
5. EDUCAÇÃO EM SAÚDE: Alimentação, atividade física leve, cuidados com pés (diabéticos), medição da pressão.

REGRAS ABSOLUTAS:
- Nunca altere doses ou prescrições
- Linguagem simples, acolhedora, sem termos técnicos
- Máximo 4 parágrafos por resposta
- Sempre termine com encorajamento quando o paciente estiver desanimado
- Só mencione medicamentos disponíveis no SUS/REMUME
- Em emergências: SAMU 192`;

const historicos = {};
const pacientes = [];

// ═══════════════════════════════════════════════════════════════════════════════
// PROXY CLAUDE — chamado pelo painel (evita CORS no browser)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  try {
    const { model, max_tokens, system, messages } = req.body;

    if (!CLAUDE_KEY) {
      return res.status(500).json({ error: 'CLAUDE_KEY não configurada no servidor.' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system: system || '',
        messages: messages || []
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (erro) {
    console.error('Erro no proxy Claude:', erro.message);
    res.status(500).json({ error: erro.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK WHATSAPP
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body || !body.data) return;
    const data = body.data;
    if (data.key?.fromMe) return;
    const numero = data.key?.remoteJid;
    const mensagem = data.message?.conversation ||
                     data.message?.extendedTextMessage?.text || '';
    if (!mensagem || !numero) return;
    if (numero.includes('@g.us')) return;
    console.log(`Mensagem de ${numero}: ${mensagem}`);
    const paciente = pacientes.find(p => numero.includes(p.telefone));
    const contextoPaciente = paciente
      ? `\nPACIENTE IDENTIFICADO: ${paciente.nome}, ${paciente.idade} anos, condições: ${paciente.condicoes?.join(', ')}, medicamentos: ${paciente.medicamentos?.map(m => `${m.nome} (${m.dose} - ${m.horarios?.join(', ')})`).join('; ')}`
      : '';
    if (!historicos[numero]) historicos[numero] = [];
    historicos[numero].push({ role: 'user', content: mensagem });
    if (historicos[numero].length > 10) historicos[numero] = historicos[numero].slice(-10);
    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: SYSTEM + contextoPaciente,
        messages: historicos[numero]
      })
    });
    const dados = await resposta.json();
    const texto = dados.content?.[0]?.text || 'Desculpe, tive um problema. Tente novamente.';
    historicos[numero].push({ role: 'assistant', content: texto });
    await enviarMensagem(numero, texto);
  } catch (erro) {
    console.error('Erro no webhook:', erro.message);
  }
});

async function enviarMensagem(numero, texto) {
  try {
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: numero, text: texto })
    });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACIENTES
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/pacientes', (req, res) => {
  const paciente = req.body;
  const index = pacientes.findIndex(p => p.id === paciente.id);
  if (index >= 0) pacientes[index] = paciente;
  else pacientes.push(paciente);
  console.log(`Paciente cadastrado: ${paciente.nome}`);
  res.json({ ok: true, total: pacientes.length });
});

app.delete('/pacientes/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = pacientes.findIndex(p => p.id === id);
  if (index >= 0) {
    const nome = pacientes[index].nome;
    pacientes.splice(index, 1);
    console.log(`Paciente removido: ${nome}`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Paciente não encontrado' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAÚDE
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: '✅ FarmaBot SUS rodando!',
    pacientes: pacientes.length,
    versao: '2.0.0',
    municipio: 'Trindade-GO',
    endpoints: ['/api/claude', '/webhook', '/pacientes']
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEMBRETES AUTOMÁTICOS
// ═══════════════════════════════════════════════════════════════════════════════
const LEMBRETES = {
  '0 7 * * *':   { horario: '07:00', msg: '🌅 Bom dia! Hora do remédio da manhã.' },
  '30 7 * * *':  { horario: '07:30', msg: '☕ Antes do café da manhã — tome o remédio agora.' },
  '0 12 * * *':  { horario: '12:00', msg: '🍽️ Hora do almoço! Lembre do remédio junto com a refeição.' },
  '30 19 * * *': { horario: '19:30', msg: '🍛 Hora do jantar! Não esqueça do remédio.' },
  '0 19 * * *':  { horario: '19:00', msg: '🌙 Hora da dose da tarde/noite do remédio da pressão.' },
  '0 22 * * *':  { horario: '22:00', msg: '💊 Hora do remédio da noite. Tome antes de dormir.' },
};

Object.entries(LEMBRETES).forEach(([cron_expr, { horario, msg }]) => {
  cron.schedule(cron_expr, () => {
    pacientes.forEach(paciente => {
      const temHorario = paciente.medicamentos?.some(m =>
        m.horarios?.some(h =>
          h.toLowerCase().includes(horario.substring(0,2)) ||
          (horario === '07:00' && h.includes('manhã')) ||
          (horario === '07:30' && h.includes('café')) ||
          (horario === '12:00' && h.includes('almoço')) ||
          (horario === '19:30' && h.includes('jantar')) ||
          (horario === '22:00' && h.includes('noite'))
        )
      );
      if (temHorario && paciente.telefone) {
        const numero = `55${paciente.telefone}@s.whatsapp.net`;
        enviarMensagem(numero, `Olá, ${paciente.nome.split(' ')[0]}! ${msg}`);
        console.log(`Lembrete para ${paciente.nome} às ${horario}`);
      }
    });
  }, { timezone: 'America/Sao_Paulo' });
});
// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK Z-API — recebe mensagens do WhatsApp
// ═══════════════════════════════════════════════════════════════════════════════
const ZAPI_INSTANCE = '3F4D6B03EE9C617B8CDD0252E275B4B9';
const ZAPI_TOKEN    = 'A4D3736EEDDA74521229CB3B';

app.post('/webhook/zapi', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body || body.fromMe) return;
    const numero  = body.phone;
    const texto   = body.text?.message || body.message || '';
    if (!texto || !numero) return;
    if (body.isGroup) return;
    console.log(`📩 Z-API | ${numero}: ${texto}`);

    const paciente = pacientes.find(p => numero.includes(p.telefone));

    // Emergência
    const ehEmergencia = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto']
      .some(g => texto.toLowerCase().includes(g));
    if (ehEmergencia) {
      await zapiEnviar(numero, '🚨 ATENÇÃO! Pelos sintomas que descreveu, ligue AGORA para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!');
      return;
    }

    // Pergunta sobre estoque → encaminhar para farmacêutico
    const ehEstoque = ['tem ','disponível','disponivel','acabou','faltou','buscar','retirar','pegar','estoque']
      .some(g => texto.toLowerCase().includes(g));
    if (ehEstoque) {
      await zapiEnviar(numero, 'Sua mensagem foi encaminhada para o farmacêutico da sua UBS. ⏳\n\nEm breve você receberá uma resposta. Emergências: SAMU 192.');
      return;
    }

    // IA responde
    if (!historicos[numero]) historicos[numero] = [];
    historicos[numero].push({ role: 'user', content: texto });
    if (historicos[numero].length > 10) historicos[numero] = historicos[numero].slice(-10);

    const contextoPaciente = paciente
      ? `\nPACIENTE: ${paciente.nome}, ${paciente.idade} anos, condições: ${paciente.condicoes?.join(', ')}, medicamentos: ${paciente.medicamentos?.map(m=>`${m.nome} (${m.dose})`).join('; ')}`
      : '';

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM + contextoPaciente,
        messages: historicos[numero]
      })
    });
    const dados = await resposta.json();
    const respostaTexto = dados.content?.[0]?.text || 'Desculpe, tive um problema. Tente novamente.';
    historicos[numero].push({ role: 'assistant', content: respostaTexto });
    await zapiEnviar(numero, respostaTexto);
  } catch(e) {
    console.error('Erro webhook Z-API:', e.message);
  }
});

async function zapiEnviar(numero, mensagem) {
  try {
    await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: numero, message: mensagem })
    });
  } catch(e) {
    console.error('Erro ao enviar Z-API:', e.message);
  }
}
app.listen(PORT, () => {
  console.log(`✅ FarmaBot SUS rodando na porta ${PORT}`);
  console.log(`Município: Trindade-GO | DAF`);
});
