const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const CLAUDE_KEY = process.env.CLAUDE_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const INSTANCE = process.env.INSTANCE_NAME || 'farmabot-trindade';
const PORT = process.env.PORT || 3000;

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

// Histórico de conversas por número
const historicos = {};

// Pacientes cadastrados (em memória — depois migrar para banco)
const pacientes = [];

// Receber mensagens do WhatsApp
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
    if (numero.includes('@g.us')) return; // ignorar grupos
    
    console.log(`Mensagem de ${numero}: ${mensagem}`);
    
    // Buscar paciente cadastrado
    const paciente = pacientes.find(p => numero.includes(p.telefone));
    const contextoPaciente = paciente 
      ? `\nPACIENTE IDENTIFICADO: ${paciente.nome}, ${paciente.idade} anos, condições: ${paciente.condicoes?.join(', ')}, medicamentos: ${paciente.medicamentos?.map(m => `${m.nome} (${m.dose} - ${m.horarios?.join(', ')})`).join('; ')}`
      : '';
    
    // Montar histórico
    if (!historicos[numero]) historicos[numero] = [];
    historicos[numero].push({ role: 'user', content: mensagem });
    
    // Manter apenas as últimas 10 mensagens
    if (historicos[numero].length > 10) {
      historicos[numero] = historicos[numero].slice(-10);
    }
    
    // Chamar a IA
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
    
    // Salvar resposta no histórico
    historicos[numero].push({ role: 'assistant', content: texto });
    
    // Enviar resposta via WhatsApp
    await enviarMensagem(numero, texto);
    
  } catch (erro) {
    console.error('Erro no webhook:', erro.message);
  }
});

// Função para enviar mensagem
async function enviarMensagem(numero, texto) {
  try {
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_KEY
      },
      body: JSON.stringify({ number: numero, text: texto })
    });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro.message);
  }
}

// Endpoint para cadastrar paciente (chamado pelo painel)
app.post('/pacientes', (req, res) => {
  const paciente = req.body;
  const index = pacientes.findIndex(p => p.id === paciente.id);
  if (index >= 0) {
    pacientes[index] = paciente;
  } else {
    pacientes.push(paciente);
  }
  console.log(`Paciente cadastrado: ${paciente.nome}`);
  res.json({ ok: true, total: pacientes.length });
});

// Endpoint de saúde
app.get('/', (req, res) => {
  res.json({ 
    status: 'FarmaBot SUS rodando!',
    pacientes: pacientes.length,
    versao: '1.0.0',
    municipio: 'Trindade-GO'
  });
});

// Lembretes automáticos por horário
const LEMBRETES = {
  '0 7 * * *':  { horario: '07:00', msg: '🌅 Bom dia! Hora do remédio da manhã. Não esqueça de tomar com água.' },
  '30 7 * * *': { horario: '07:30', msg: '☕ Antes do café da manhã — tome o remédio do diabetes agora.' },
  '0 12 * * *': { horario: '12:00', msg: '🍽️ Hora do almoço! Lembre do remédio junto com a refeição.' },
  '30 19 * * *':{ horario: '19:30', msg: '🍛 Hora do jantar! Não esqueça do remédio do diabetes.' },
  '0 19 * * *': { horario: '19:00', msg: '🌙 Boa noite! Hora da dose da tarde/noite do remédio da pressão.' },
  '0 22 * * *': { horario: '22:00', msg: '💊 Hora do remédio da noite. Tome antes de dormir conforme orientado.' },
};

Object.entries(LEMBRETES).forEach(([cron_expr, { horario, msg }]) => {
  cron.schedule(cron_expr, () => {
    pacientes.forEach(paciente => {
      const temHorario = paciente.medicamentos?.some(m => 
        m.horarios?.some(h => h.toLowerCase().includes(horario.substring(0,2)) || 
          (horario === '07:00' && h.includes('manhã')) ||
          (horario === '07:30' && h.includes('café')) ||
          (horario === '12:00' && h.includes('almoço')) ||
          (horario === '19:30' && h.includes('jantar')) ||
          (horario === '19:00' && h.includes('noite') && h.includes('tarde')) ||
          (horario === '22:00' && h.includes('noite'))
        )
      );
      
      if (temHorario && paciente.telefone) {
        const numero = `55${paciente.telefone}@s.whatsapp.net`;
        const msgPersonalizada = `Olá, ${paciente.nome.split(' ')[0]}! ${msg}`;
        enviarMensagem(numero, msgPersonalizada);
        console.log(`Lembrete enviado para ${paciente.nome} às ${horario}`);
      }
    });
  }, { timezone: 'America/Sao_Paulo' });
});

app.listen(PORT, () => {
  console.log(`FarmaBot SUS rodando na porta ${PORT}`);
  console.log(`Municipio: Trindade-GO | DAF`);
});
