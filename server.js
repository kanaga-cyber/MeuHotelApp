const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fazerBackup = require('./backup');

// Backup automático a cada 6 horas
fazerBackup();
setInterval(fazerBackup, 6 * 60 * 60 * 1000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));
app.use(express.json());

const db = new sqlite3.Database('hotel.db');

// ==================== QUARTOS ====================
app.get('/quartos', (req, res) => {
  db.all('SELECT * FROM quartos ORDER BY numero', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ==================== LIMPEZAS ====================
app.get('/limpezas', (req, res) => {
  db.all('SELECT * FROM limpezas ORDER BY timestamp DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/limpeza', (req, res) => {
  const { ala, tempo, tarefas } = req.body;
  db.run('INSERT INTO limpezas (ala, tempo, tarefas) VALUES (?, ?, ?)',
    [ala, tempo, tarefas], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'limpeza');
      res.json({ id: this.lastID });
    });
});

// ==================== LIMPEZAS POR QUARTO (PARA RELATÓRIO DAS CAMAREIRAS) ====================
app.post('/limpeza-quarto', (req, res) => {
  const {
    quarto_numero,
    camareira_nome,
    tipo_servico,      // 'arrumacao' | 'troca_enxoval' | 'checkout' | 'dispensa'
    detalhes_enxoval,  // ex: 'piso e rosto', 'enxoval completo'
    data               // formato: '2026-04-20'
  } = req.body;

  // Validação básica
  if (!quarto_numero || !camareira_nome || !tipo_servico || !data) {
    return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
  }

  db.run(
    `INSERT INTO limpezas_quartos
      (quarto_numero, camareira_nome, tipo_servico, detalhes_enxoval, data)
     VALUES (?, ?, ?, ?, ?)`,
    [quarto_numero, camareira_nome, tipo_servico, detalhes_enxoval || '', data],
    function (err) {
      if (err) {
        console.error('Erro ao registrar limpeza_quarto:', err.message);
        return res.status(500).json({ error: err.message });
      }
      io.emit('update', 'limpeza_quarto');
      res.json({ id: this.lastID });
    }
  );
});

// ==================== CHECK-IN/OUT ====================
app.post('/checkin', (req, res) => {
  const { quarto_numero, nome_hospede, checkin, checkout } = req.body;
  db.run('INSERT INTO checkin_checkout (quarto_numero, nome_hospede, checkin, checkout) VALUES (?, ?, ?, ?)',
    [quarto_numero, nome_hospede, checkin, checkout], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE quartos SET status = "ocupado" WHERE numero = ?', [quarto_numero]);
      io.emit('update', 'checkin');
      res.json({ id: this.lastID });
    });
});

app.post('/checkout', (req, res) => {
  const { quarto_numero } = req.body;
  db.run('UPDATE quartos SET status = "disponivel" WHERE numero = ?', [quarto_numero], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('update', 'checkout');
    res.json({ ok: true });
  });
});

// ==================== MANUTENÇÃO ====================
app.post('/manutencao', (req, res) => {
  const { quarto_numero, observacao } = req.body;
  db.run('INSERT INTO manutencao (quarto_numero, observacao) VALUES (?, ?)',
    [quarto_numero, observacao], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'manutencao');
      res.json({ id: this.lastID });
    });
});

app.get('/manutencao', (req, res) => {
  db.all('SELECT * FROM manutencao ORDER BY registrado_em DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/manutencao/resolver', (req, res) => {
  const { id, resolvido_por } = req.body;
  db.run(`UPDATE manutencao SET status='resolvido', resolvido_por=?, resolvido_em=CURRENT_TIMESTAMP WHERE id=?`,
    [resolvido_por, id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'manutencao');
      res.json({ ok: true });
    });
});

app.post('/manutencao/vistoria', (req, res) => {
  const { id, vistoriado_por } = req.body;
  db.run(`UPDATE manutencao SET status='concluido', vistoriado_por=?, vistoriado_em=CURRENT_TIMESTAMP WHERE id=?`,
    [vistoriado_por, id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'manutencao');
      res.json({ ok: true });
    });
});
// ==================== ENXOVAL ====================
app.get('/enxoval/estoque', (req, res) => {
  db.all('SELECT * FROM enxoval_estoque ORDER BY peca', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Calcula o que está nos quartos para cada peça
    const calcularQuartos = (index, resultado) => {
      if (index >= rows.length) return res.json(resultado);

      const row = rows[index];
      db.get(`SELECT 
        COALESCE(SUM(quantidade_entrou), 0) as nos_quartos
        FROM enxoval_movimentacao WHERE peca = ?`,
        [row.peca], (err, calc) => {
          const nosQuartos = Math.max(0, calc ? calc.nos_quartos : 0);
          resultado.push({ ...row, nos_quartos: nosQuartos });
          calcularQuartos(index + 1, resultado);
        });
    };

    calcularQuartos(0, []);
  });
});

app.post('/enxoval/ajustar', (req, res) => {
  const { peca, quantidade_total, na_rouparia } = req.body;
  db.run(`UPDATE enxoval_estoque SET quantidade_total=?, na_rouparia=?, atualizado_em=CURRENT_TIMESTAMP WHERE peca=?`,
    [quantidade_total, na_rouparia, peca], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'estoque');
      res.json({ ok: true });
    });
});

app.post('/enxoval/movimentacao', (req, res) => {
  const { quarto_numero, itens, registrado_por, perfil } = req.body;
  let pendentes = itens.length;
  itens.forEach(item => {
    db.run(`INSERT INTO enxoval_movimentacao 
      (quarto_numero, peca, quantidade_saiu, quantidade_entrou, danificados, registrado_por, perfil, observacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [quarto_numero, item.peca, item.saiu||0, item.entrou||0, item.danificados||0, registrado_por, perfil, item.obs_dano||''],
      function (err) {
        if (!err && item.danificados > 0) {
          db.run(`UPDATE enxoval_estoque SET danificados = danificados + ? WHERE peca=?`,
            [item.danificados, item.peca]);
        }
        pendentes--;
        if (pendentes === 0) {
          io.emit('update', 'enxoval');
          res.json({ ok: true });
        }
      });
  });
});

app.get('/enxoval/movimentacoes', (req, res) => {
  db.all(`SELECT * FROM enxoval_movimentacao 
    WHERE date(timestamp)=date('now','localtime') 
    ORDER BY timestamp DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/enxoval/danificados', (req, res) => {
  db.all(`SELECT * FROM enxoval_movimentacao 
    WHERE danificados > 0 
    ORDER BY timestamp DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/enxoval/avaliar-dano', (req, res) => {
  const { id, peca, danificados, acao, avaliado_por } = req.body;
  if (acao === 'devolver') {
    db.run(`UPDATE enxoval_estoque SET danificados=danificados-?, na_rouparia=na_rouparia+? WHERE peca=?`,
      [danificados, danificados, peca]);
  } else {
    db.run(`UPDATE enxoval_estoque SET danificados=danificados-?, quantidade_total=quantidade_total-? WHERE peca=?`,
      [danificados, danificados, peca]);
  }
  db.run(`UPDATE enxoval_movimentacao SET observacao=observacao||' | Avaliado: ${avaliado_por} - ${acao}' WHERE id=?`, [id]);
  io.emit('update', 'enxoval');
  res.json({ ok: true });
});

app.post('/enxoval/editar', (req, res) => {
  const { id, saiu, entrou, danificados, obs } = req.body;
  db.run(`UPDATE enxoval_movimentacao SET quantidade_saiu=?, quantidade_entrou=?, danificados=?, observacao=? WHERE id=?`,
    [saiu, entrou, danificados, obs, id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'enxoval');
      res.json({ ok: true });
    });
});

// ==================== IMPORTAR CSV HITS ====================
app.post('/importar-csv', upload.single('csv'), (req, res) => {
  try {
    const conteudo = req.file.buffer.toString('utf-8');
    const registros = parse(conteudo, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const resultado = [];
    const hoje = new Date();
    const diaHoje = String(hoje.getDate()).padStart(2, '0');
    const mesHoje = String(hoje.getMonth() + 1).padStart(2, '0');
    const dataHoje = `${diaHoje}/${mesHoje}`;

    for (const row of registros) {
      const numero = parseInt(row.apto);
      if (!numero || numero < 1 || numero > 48) continue;

      const status = (row.status || '').trim();
      const servico = (row.servico || '').trim();
      const checkin = (row.checkin || '').trim();
      const checkout = (row.checkout || '').trim();
      const adultos = parseInt(row.adultos) || 0;
      const criancas = parseInt(row.criancas) || 0;

      let novoStatus = 'disponivel';
      let acao = 'matem';

      if (status === 'Interdição') {
        novoStatus = 'interditado';
        acao = 'interditado';
      } else if (servico === 'Chegada hoje' || (checkin && checkin.startsWith(dataHoje))) {
        novoStatus = 'ocupado';
        acao = 'checkin';
      } else if (servico === 'Check-out' || (checkout && checkout.startsWith(dataHoje))) {
        novoStatus = 'disponivel';
        acao = 'checkout';
      } else if (status === 'Ocupado') {
        novoStatus = 'ocupado';
        acao = 'matem';
      } else {
        novoStatus = 'disponivel';
        acao = 'matem';
      }

      resultado.push({
        numero, status: novoStatus, acao,
        checkin, checkout, adultos, criancas, servico
      });
    }

    res.json({ ok: true, resultado });
  } catch (err) {
    console.error('Erro CSV:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CONFIRMAR IMPORTAÇÃO ====================
app.post('/importar-confirmar', (req, res) => {
  const { quartos } = req.body;
  let pendentes = quartos.length;

  quartos.forEach(q => {
    db.run('UPDATE quartos SET status=? WHERE numero=?', [q.status, q.numero], () => {
      if (q.acao === 'checkin' && q.checkin) {
        db.run(`INSERT INTO checkin_checkout (quarto_numero, nome_hospede, checkin, checkout) 
          VALUES (?, ?, ?, ?)`,
          [q.numero, `${q.adultos} Ad / ${q.criancas} Cr`, q.checkin, q.checkout]);
      }
      pendentes--;
      if (pendentes === 0) {
        io.emit('update', 'importacao');
        res.json({ ok: true, total: quartos.length });
      }
    });
  });
});
// ==================== CRONÔMETRO DE LIMPEZA ====================

app.post('/cronometro/iniciar', (req, res) => {
  const { quarto_numero, camareira, tipo_servico } = req.body;
  db.get(`SELECT * FROM limpeza_cronometro WHERE quarto_numero=? AND status='em_andamento'`,
    [quarto_numero], (err, row) => {
      if (row) return res.status(400).json({ error: 'Já existe uma limpeza em andamento nesse apartamento!' });
      db.get('SELECT ala, categoria FROM quartos WHERE numero=?', [quarto_numero], (err, quarto) => {
        if (!quarto) return res.status(404).json({ error: 'Apartamento não encontrado!' });
        // Horário de Brasília (UTC-3)
const agora = new Date();
const brasilia = new Date(agora.getTime() - (3 * 60 * 60 * 1000));
const inicioBrasilia = brasilia.toISOString().replace('T', ' ').slice(0, 19);

db.run(`INSERT INTO limpeza_cronometro (quarto_numero, ala, categoria, camareira, tipo_servico, inicio) VALUES (?, ?, ?, ?, ?, ?)`,
  [quarto_numero, quarto.ala, quarto.categoria, camareira, tipo_servico, inicioBrasilia],
          function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run('UPDATE quartos SET status="em_limpeza" WHERE numero=?', [quarto_numero]);
            io.emit('update', 'cronometro');
            res.json({ id: this.lastID, inicio: new Date() });
          });
      });
    });
});

app.post('/cronometro/finalizar', (req, res) => {
  const { id, quarto_numero } = req.body;
  db.get(`SELECT * FROM limpeza_cronometro WHERE id=?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Limpeza não encontrada!' });

    const inicio = new Date(row.inicio);
    const fim = new Date();
    const duracao = Math.max(1, Math.round((fim - inicio) / 60000));
    console.log(`Início: ${inicio}, Fim: ${fim}, Duração: ${duracao} min`);

    db.run(`UPDATE limpeza_cronometro SET fim=CURRENT_TIMESTAMP, duracao_minutos=?, status='concluido' WHERE id=?`,
      [duracao, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE quartos SET status="disponivel" WHERE numero=?', [quarto_numero]);
        io.emit('update', 'cronometro');
        res.json({ ok: true, duracao });
      });
  });
});

app.get('/cronometro/andamento', (req, res) => {
  db.all(`SELECT * FROM limpeza_cronometro 
    WHERE status='em_andamento' 
    ORDER BY inicio`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Calcula segundos decorridos no Node.js
      const agora = new Date();
      const resultado = rows.map(row => {
       const inicio = new Date(row.inicio.replace(' ', 'T') + '.000Z');
       const inicioAjustado = new Date(inicio.getTime() + (3 * 60 * 60 * 1000));
        const segundos = Math.max(0, Math.round((agora - inicioAjustado) / 1000));
        return { ...row, segundos_decorridos: segundos };
      });
      
      res.json(resultado);
    });
});

app.get('/cronometro/relatorio', (req, res) => {
  db.all(`SELECT * FROM limpeza_cronometro 
    WHERE date(inicio)=date('now','localtime') AND status='concluido'
    ORDER BY inicio DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

app.get('/cronometro/por-camareira', (req, res) => {
  db.all(`SELECT 
      camareira,
      COUNT(*) as total_limpezas,
      ROUND(AVG(duracao_minutos), 1) as media_minutos,
      MIN(duracao_minutos) as menor_tempo,
      MAX(duracao_minutos) as maior_tempo,
      SUM(duracao_minutos) as total_minutos
    FROM limpeza_cronometro 
    WHERE status='concluido' AND date(inicio)=date('now','localtime')
    GROUP BY camareira
    ORDER BY camareira`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

app.get('/cronometro/por-categoria', (req, res) => {
  db.all(`SELECT 
      categoria,
      COUNT(*) as total_limpezas,
      ROUND(AVG(duracao_minutos), 1) as media_minutos
    FROM limpeza_cronometro 
    WHERE status='concluido'
    GROUP BY categoria
    ORDER BY categoria`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

// ==================== LAVANDERIA ====================

console.log('Rotas da lavanderia carregadas!');

// Ver pendentes (saíram dos quartos mas não foram enviados)
app.get('/lavanderia/pendentes', (req, res) => {
  db.all(`SELECT peca, SUM(quantidade_saiu) as total
    FROM enxoval_movimentacao
    WHERE quantidade_saiu > 0
    AND date(timestamp) = date('now','localtime')
    GROUP BY peca
    ORDER BY peca`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Enviar para lavanderia
app.post('/lavanderia/enviar', (req, res) => {
  const { itens, enviado_por } = req.body;
  let pendentes = itens.length;

  itens.forEach(item => {
    db.run(`INSERT INTO enxoval_lavanderia (peca, quantidade, status, enviado_em, enviado_por)
      VALUES (?, ?, 'enviado', datetime('now','localtime'), ?)`,
      [item.peca, item.quantidade, enviado_por],
      function(err) {
        if (!err) {
          // Desconta da rouparia
          db.run(`UPDATE enxoval_estoque SET na_rouparia = na_rouparia - ?,
            na_lavanderia = na_lavanderia + ? WHERE peca = ?`,
            [item.quantidade, item.quantidade, item.peca]);
        }
        pendentes--;
        if (pendentes === 0) {
          io.emit('update', 'lavanderia');
          res.json({ ok: true });
        }
      });
  });
});

// Ver o que está na lavanderia
app.get('/lavanderia/emandamento', (req, res) => {
  db.all(`SELECT * FROM enxoval_lavanderia
    WHERE status = 'enviado'
    ORDER BY enviado_em DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Confirmar retorno (parcial ou total)
app.post('/lavanderia/retorno', (req, res) => {
  const { id, peca, quantidade_retornada, retornado_por } = req.body;

  db.get(`SELECT * FROM enxoval_lavanderia WHERE id = ?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Registro não encontrado!' });

    const restante = row.quantidade - quantidade_retornada;
    const novoStatus = restante <= 0 ? 'retornado' : 'retorno_parcial';

    db.run(`UPDATE enxoval_lavanderia SET
      quantidade_retornada = ?,
      status = ?,
      retornado_em = datetime('now','localtime'),
      retornado_por = ?
      WHERE id = ?`,
      [quantidade_retornada, novoStatus, retornado_por, id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Volta para rouparia e desconta da lavanderia
        db.run(`UPDATE enxoval_estoque SET
          na_rouparia = na_rouparia + ?,
          na_lavanderia = na_lavanderia - ?
          WHERE peca = ?`,
          [quantidade_retornada, quantidade_retornada, peca]);

        io.emit('update', 'lavanderia');
        res.json({ ok: true, restante });
      });
  });
});

// Histórico de envios
app.get('/lavanderia/historico', (req, res) => {
  db.all(`SELECT * FROM enxoval_lavanderia
    ORDER BY registrado_em DESC
    LIMIT 50`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ==================== RELATÓRIOS POR DATA ====================

app.get('/relatorio/limpezas', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT 
      camareira,
      COUNT(*) as total_limpezas,
      ROUND(AVG(duracao_minutos), 1) as media_minutos,
      MIN(duracao_minutos) as menor_tempo,
      MAX(duracao_minutos) as maior_tempo,
      SUM(duracao_minutos) as total_minutos,
      GROUP_CONCAT(quarto_numero || '(' || tipo_servico || ')') as quartos
    FROM limpeza_cronometro
    WHERE status='concluido' AND date(inicio)=?
    GROUP BY camareira
    ORDER BY camareira`, [data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/relatorio/limpezas-detalhe', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT * FROM limpeza_cronometro
    WHERE status='concluido' AND date(inicio)=?
    ORDER BY inicio`, [data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/relatorio/manutencoes', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT * FROM manutencao
    WHERE date(registrado_em)=?
    ORDER BY registrado_em`, [data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/relatorio/checkins', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT * FROM checkin_checkout
    WHERE date(checkin)=? OR date(checkout)=?
    ORDER BY checkin`, [data, data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Cancelar limpeza em andamento
app.post('/cronometro/cancelar', (req, res) => {
  const { id, quarto_numero } = req.body;
  db.run(`UPDATE limpeza_cronometro SET status='cancelado' WHERE id=?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run('UPDATE quartos SET status="disponivel" WHERE numero=?', [quarto_numero]);
    io.emit('update', 'cronometro');
    res.json({ ok: true });
  });
});

// ==================== EQUIPE ====================

// Listar camareiras ativas
app.get('/equipe', (req, res) => {
  db.all(`SELECT * FROM equipe WHERE ativo=1 ORDER BY nome`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Adicionar camareira
app.post('/equipe', (req, res) => {
  const { nome, cargo } = req.body;
  db.run(`INSERT INTO equipe (nome, cargo) VALUES (?, ?)`,
    [nome, cargo || 'camareira'], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'equipe');
      res.json({ id: this.lastID });
    });
});

// Desativar camareira
app.post('/equipe/desativar', (req, res) => {
  const { id } = req.body;
  db.run(`UPDATE equipe SET ativo=0 WHERE id=?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('update', 'equipe');
    res.json({ ok: true });
  });
});

// Reativar camareira
app.post('/equipe/reativar', (req, res) => {
  const { id } = req.body;
  db.run(`UPDATE equipe SET ativo=1 WHERE id=?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('update', 'equipe');
    res.json({ ok: true });
  });
});

// ==================== RELATÓRIO DE ENXOVAL POR DATA ====================

app.get('/relatorio/enxoval-resumo', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT 
      peca,
      SUM(quantidade_saiu) as total_saiu,
      SUM(quantidade_entrou) as total_entrou,
      SUM(danificados) as total_danificados,
      COUNT(DISTINCT quarto_numero) as total_quartos
    FROM enxoval_movimentacao
    WHERE date(timestamp) = ?
    GROUP BY peca
    ORDER BY peca`, [data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/relatorio/enxoval-apartamentos', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT 
      em.*,
      q.ala,
      q.categoria
    FROM enxoval_movimentacao em
    LEFT JOIN quartos q ON em.quarto_numero = q.numero
    WHERE date(em.timestamp) = ?
    ORDER BY em.quarto_numero, em.peca`, [data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/relatorio/enxoval-lavanderia', (req, res) => {
  const { data } = req.query;
  db.all(`SELECT * FROM enxoval_lavanderia
    WHERE date(enviado_em) = ? OR date(retornado_em) = ?
    ORDER BY enviado_em DESC`, [data, data], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Pausar limpeza
app.post('/cronometro/pausar', (req, res) => {
  const { id } = req.body;
  db.run(`UPDATE limpeza_cronometro SET status='pausado' WHERE id=?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('update', 'cronometro');
    res.json({ ok: true });
  });
});

// Retomar limpeza
app.post('/cronometro/retomar', (req, res) => {
  const { id, tempo_pausa } = req.body;
  db.run(`UPDATE limpeza_cronometro SET status='em_andamento', tempo_pausa_minutos=tempo_pausa_minutos+? WHERE id=?`,
    [tempo_pausa, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('update', 'cronometro');
      res.json({ ok: true });
    });
});

// ==================== RELATÓRIO DIÁRIO DA CAMAREIRA ====================
app.get('/relatorio-diario-camareira', (req, res) => {
  const { camareira, data } = req.query;

  if (!camareira || !data) {
    return res.status(400).json({ error: 'Informe camareira e data no formato AAAA-MM-DD.' });
  }

  db.all(
    `SELECT * FROM limpezas_quartos
     WHERE camareira_nome = ?
       AND data = ?
     ORDER BY quarto_numero ASC`,
    [camareira, data],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!rows || rows.length === 0) {
        return res.json({
          texto: `Hotel Encantos de Itaperapuã\n📅 Resumo da camareira – ${data}\n👤 Camareira: ${camareira}\n\nNenhum registro de serviço para esta data.`
        });
      }

      const limpezas = rows.filter(r => r.tipo_servico === 'arrumacao' || r.tipo_servico === 'checkout');
      const trocas = rows.filter(r => r.tipo_servico === 'troca_enxoval');
      const dispensas = rows.filter(r => r.tipo_servico === 'dispensa');

      let texto = `Hotel Encantos de Itaperapuã\n📅 Resumo da camareira – ${data}\n👤 Camareira: ${camareira}\n\n`;

      texto += '🧹 Limpezas realizadas (todas com troca de piso):\n';
      if (limpezas.length === 0) {
        texto += '• Nenhuma limpeza registrada.\n\n';
      } else {
        limpezas.forEach(r => {
          if (r.tipo_servico === 'checkout') {
            texto += `• UH ${r.quarto_numero} – Check-out (troca total de enxoval)\n`;
          } else {
            texto += `• UH ${r.quarto_numero} – Arrumação\n`;
          }
        });
        texto += '\n';
      }

      texto += '🧺 Unidades com troca de enxoval (além do piso):\n';
      if (trocas.length === 0) {
        texto += '• Nenhuma troca de enxoval registrada.\n\n';
      } else {
        trocas.forEach(r => {
          const detalhe = r.detalhes_enxoval && r.detalhes_enxoval.trim().length > 0
            ? r.detalhes_enxoval
            : 'enxoval registrado';
          texto += `• UH ${r.quarto_numero} – ${detalhe}\n`;
        });
        texto += '\n';
      }

      texto += '🚫 Quartos com dispensa de limpeza:\n';
      if (dispensas.length === 0) {
        texto += '• Nenhuma dispensa registrada.\n';
      } else {
        dispensas.forEach(r => {
          texto += `• UH ${r.quarto_numero}\n`;
        });
      }

      res.json({ texto });
    }
  );
});

// ==================== SOCKET E SERVIDOR ====================
io.on('connection', (socket) => {
  console.log('Cliente conectado');
});

server.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
