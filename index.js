require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

const app = express();

// ===== CORS / JSON
app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cache-Control",
      "Pragma",
    ],
  })
);
// Preflight universal
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ===== MySQL Pool (com timeout)
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 8000,
  enableKeepAlive: true,
});

/** Utilitário de timeout para qualquer promise */
function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

/** Helpers de paginação */
function parseLimitOffset(req, defLimit = 50, maxLimit = 200) {
  let limit = Number(req.query.limit ?? defLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit <= 0) limit = defLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

/** Normaliza status vindo do front para código 0/1/2 */
function normalizeStatusToCode(input) {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "ativo") return 0;
  if (raw === "1" || raw === "atendimento") return 1;
  if (raw === "2" || raw === "desativado") return 2;
  if (raw === "3" || raw === "deletado") return 3;
  return 0;
}

/** Normaliza string: sem acento/caixa/espacos extras */
function normalizeName(s = "") {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Busca cidade sem acento/caixa; se não achar e UF vier, cria; se precisar criar e faltar UF -> erro 400 */
async function ensureCityByName(pool, nomeCidadeRaw, ufRaw = null) {
  const nomeCidade = String(nomeCidadeRaw || "").trim();
  if (!nomeCidade) return null;

  const norm = normalizeName(nomeCidade);
  const uf = ufRaw ? String(ufRaw).trim().toUpperCase() : null;

  // 1) tenta match exato por nome + (UF se vier)
  {
    const sql = uf
      ? "SELECT id, nome, uf FROM cidades WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) AND UPPER(TRIM(uf)) = UPPER(TRIM(?)) LIMIT 2"
      : "SELECT id, nome, uf FROM cidades WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) LIMIT 2";
    const params = uf ? [nomeCidade, uf] : [nomeCidade];

    const [rows] = await withTimeout(
      pool.execute(sql, params),
      4000,
      "db_timeout"
    );
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      throw new Error(
        uf
          ? `Cidade ambígua: existe mais de uma "${nomeCidade}/${uf}".`
          : `Cidade ambígua para "${nomeCidade}". Especifique UF (ex.: "${nomeCidade}/UF").`
      );
    }
  }

  // 2) tenta variantes sem acento (prefixo e filtro em JS)
  {
    const prefix = nomeCidade.slice(0, 4);
    const sql = uf
      ? "SELECT id, nome, uf FROM cidades WHERE UPPER(TRIM(uf)) = UPPER(TRIM(?)) AND nome LIKE ? ORDER BY nome LIMIT 20"
      : "SELECT id, nome, uf FROM cidades WHERE nome LIKE ? ORDER BY nome LIMIT 20";
    const params = uf ? [uf, `${prefix}%`] : [`${prefix}%`];

    const [rows] = await withTimeout(
      pool.execute(sql, params),
      4000,
      "db_timeout"
    );
    const filtered = rows.filter((r) => normalizeName(r.nome) === norm);
    if (filtered.length === 1) return filtered[0];
    if (filtered.length > 1) {
      throw new Error(
        uf
          ? `Cidade ambígua: existe mais de uma "${nomeCidade}/${uf}".`
          : `Cidade ambígua para "${nomeCidade}". Especifique UF.`
      );
    }
  }

  // 3) não achou —> criar
  if (!uf) {
    const err = new Error("UF obrigatória para criar nova cidade.");
    err._badRequest = true;
    throw err;
  }

  const [res] = await withTimeout(
    pool.execute("INSERT INTO cidades (nome, uf) VALUES (?, ?)", [
      nomeCidade,
      uf,
    ]),
    4000,
    "db_timeout"
  );
  return { id: res.insertId, nome: nomeCidade, uf };
}

// ✅ Garante que módulos do equipamento sejam SEMPRE "substituídos"
// (sem depender de UNIQUE KEY / ON DUPLICATE KEY)
async function replaceUserEquipModules(
  pool,
  { usuario_id, maquina_id, agua_gelada, agua_quente, agua_pet, aspersor }
) {
  const uid = Number(usuario_id);
  const mid = Number(maquina_id);
  if (!uid || !mid) return;

  const gel = agua_gelada ? 1 : 0;
  const que = agua_quente ? 1 : 0;
  const pet = agua_pet ? 1 : 0;
  const asp = aspersor ? 1 : 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ✅ Mantém só 1 vínculo por equipamento (resolve o "tirar módulo não funciona")
    await conn.execute(
      `DELETE FROM usuarios_equipamentos WHERE maquina_id = ?`,
      [mid]
    );

    await conn.execute(
      `
      INSERT INTO usuarios_equipamentos
        (usuario_id, maquina_id, agua_gelada, agua_quente, agua_pet, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [uid, mid, gel, que, pet]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ===== /ping
app.get("/ping", (_req, res) => {
  res.type("text").send("pong-v2-sem-deleted-at");
});

// ===== /diag
app.get("/diag", async (_req, res) => {
  const info = {
    MYSQL_HOST: process.env.MYSQL_HOST,
    MYSQL_PORT: process.env.MYSQL_PORT,
    MYSQL_DB: process.env.MYSQL_DB,
    MYSQL_USER: process.env.MYSQL_USER,
  };
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DB,
      connectTimeout: 5000,
    });
    const [rows] = await conn.query(
      "SELECT USER() AS user_func, CURRENT_USER() AS current_user"
    );
    await conn.end();
    return res.json({
      ok: true,
      env: info,
      user_func: rows?.[0]?.user_func,
      current_user: rows?.[0]?.current_user,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, env: info, error: e.message });
  }
});

// ===== /health
app.get("/health", async (_req, res) => {
  try {
    const [rows] = await withTimeout(
      pool.query("SELECT 1 AS ok"),
      4000,
      "db_timeout"
    );
    return res.json({ ok: true, db: rows?.[0]?.ok === 1 });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : e.message });
  }
});

app.get("/equipamentos", async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req, 50, 10000);

    const sql = `
      SELECT
        m.id,
        m.nome,
        m.serialNumber,
        m.numeroNotaFiscal,
        m.numeroSerieEquipamento,
        m.tipo_id,
        m.cidade_id,
        c.nome AS cidade_nome,
        c.uf   AS cidade_uf,
        m.cep,
        m.bairro,
        m.endereco,
        m.numero,
        m.complemento,
        m.data_instalacao,
        m.status,
        m.observacao,
        m.created_at,
        m.updated_at
      FROM maquinas m
      LEFT JOIN cidades c ON c.id = m.cidade_id
      WHERE m.status <> 3
      ORDER BY m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await withTimeout(pool.query(sql), 20000, "db_timeout");

    return res.json({ ok: true, data: rows, limit, offset });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[GET /equipamentos]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

app.get("/equipamentos/:id/modules", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    // 1) garantir que a máquina existe e pegar observacao
    const [mRows] = await pool.query(
      `
      SELECT observacao
      FROM maquinas
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!mRows || !mRows.length) {
      return res
        .status(404)
        .json({ ok: false, error: "Equipamento não encontrado" });
    }

    const observacao = mRows[0]?.observacao ?? null;

    // 2) vínculo mais recente (se existir)
    const [ueRows] = await pool.query(
      `
      SELECT
        usuario_id,
        COALESCE(agua_gelada, 1) AS agua_gelada,
        COALESCE(agua_quente, 1) AS agua_quente,
        COALESCE(agua_pet, 1)    AS agua_pet
      FROM usuarios_equipamentos
      WHERE maquina_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
      `,
      [id]
    );

    // defaults se não existir vínculo
    const usuario_id = ueRows?.[0]?.usuario_id ?? null;
    const agua_gelada = ueRows?.[0]?.agua_gelada ?? 1;
    const agua_quente = ueRows?.[0]?.agua_quente ?? 1;
    const agua_pet = ueRows?.[0]?.agua_pet ?? 1;

    // 3) aspersor "habilitado" pelo cadastro (guardado em maquinas.observacao)
    let aspersorFromConfig = 0;
    try {
      const obj = observacao ? JSON.parse(observacao) : null;
      aspersorFromConfig = obj?.aspersor ? 1 : 0;
    } catch {
      aspersorFromConfig = 0;
    }

    // 4) aspersor pela telemetria (se já existir registro em informacoes)
    let aspersorFromTelemetry = 0;
    try {
      const [tRows] = await pool.query(
        `
        SELECT 1 AS has
        FROM informacoes
        WHERE maquina_id = ?
          AND contador_acionamentos_aspersor IS NOT NULL
        LIMIT 1
        `,
        [id]
      );
      aspersorFromTelemetry = tRows && tRows.length ? 1 : 0;
    } catch {
      aspersorFromTelemetry = 0;
    }

    // 5) regra final: aparece se telemetria já existe OU se foi marcado no cadastro
    const aspersor = aspersorFromTelemetry || aspersorFromConfig ? 1 : 0;

    return res.json({
      ok: true,
      data: {
        usuario_id,
        agua_gelada,
        agua_quente,
        agua_pet,
        aspersor,
      },
    });
  } catch (e) {
    console.error("Erro em GET /equipamentos/:id/modules:", e);
    return res.status(500).json({ error: "Erro ao buscar módulos" });
  }
});

app.post("/equipamentos", async (req, res) => {
  try {
    const {
      tipo_id,
      nome,
      serialNumber,
      numeroNotaFiscal,
      numeroSerieEquipamento,
      cidade,
      cidade_nome,
      uf,
      cep,
      bairro,
      endereco,
      numero,
      complemento,
      data_instalacao,
      status,
      observacao,
      usuario_id,
      agua_gelada = 1,
      agua_quente = 1,
      agua_pet = 1,
      aspersor = 0,
    } = req.body || {};

    const missing = [];
    if (tipo_id == null) missing.push("tipo_id");
    if (!nome) missing.push("nome");
    if (!serialNumber) missing.push("serialNumber");
    if (!data_instalacao) missing.push("data_instalacao");
    if (status == null) missing.push("status");

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Campos obrigatórios ausentes: ${missing.join(", ")}`,
      });
    }

    const statusCode = normalizeStatusToCode(status);

    // unicidade por serialNumber
    const [dups] = await withTimeout(
      pool.execute(
        `
        SELECT id
        FROM maquinas
        WHERE TRIM(serialNumber) = TRIM(?)
          AND status <> 3
        LIMIT 1
        `,
        [serialNumber]
      ),
      4000,
      "db_timeout"
    );

    if (dups.length) {
      return res
        .status(409)
        .json({ ok: false, error: "serialNumber já cadastrado" });
    }

    // ===== Resolver cidade (opcional)
    const cidadeTexto = (cidade ?? cidade_nome ?? "").toString().trim();
    let cidadeId = null;
    let ufFinal =
      String(uf || "")
        .trim()
        .toUpperCase() || null;

    if (cidadeTexto) {
      let nomeCidade = cidadeTexto;
      const slash = cidadeTexto.indexOf("/");

      if (slash > 0) {
        nomeCidade = cidadeTexto.slice(0, slash).trim();
        ufFinal =
          cidadeTexto
            .slice(slash + 1)
            .trim()
            .toUpperCase() || ufFinal;
      }

      try {
        const city = await ensureCityByName(pool, nomeCidade, ufFinal);
        cidadeId = city?.id ?? null;
      } catch (err) {
        const msg = String(err?.message || err);
        if (err && err._badRequest)
          return res.status(400).json({ ok: false, error: msg });
        return res.status(409).json({ ok: false, error: msg });
      }
    }

    // ===== Observacao JSON (aspersor habilitado)
    // Guarda o que vier em observacao (texto) + aspersor
    let observacaoFinal = null;
    try {
      const baseObj =
        observacao && String(observacao).trim()
          ? (() => {
              try {
                const parsed = JSON.parse(String(observacao));
                return parsed && typeof parsed === "object"
                  ? parsed
                  : { texto: String(observacao) };
              } catch {
                return { texto: String(observacao) };
              }
            })()
          : {};

      baseObj.aspersor = !!(
        aspersor === true ||
        aspersor === 1 ||
        aspersor === "1"
      );
      observacaoFinal = JSON.stringify(baseObj);
    } catch {
      // fallback seguro
      observacaoFinal = JSON.stringify({ aspersor: !!aspersor });
    }

    // ===== INSERT em maquinas
    const [result] = await withTimeout(
      pool.execute(
        `
        INSERT INTO maquinas
          (cidade_id, tipo_id, nome, serialNumber,
           numeroNotaFiscal, numeroSerieEquipamento,
           endereco, numero, bairro, cep, complemento,
           data_instalacao, status, observacao,
           created_at, updated_at)
        VALUES
          (?, ?, ?, ?,
           ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?,
           NOW(), NOW())
        `,
        [
          cidadeId,
          Number(tipo_id),
          nome,
          serialNumber,
          numeroNotaFiscal || null,
          numeroSerieEquipamento || null,
          endereco || null,
          numero || null,
          bairro || null,
          cep || null,
          complemento || null,
          data_instalacao,
          statusCode,
          observacaoFinal,
        ]
      ),
      6000,
      "db_timeout"
    );

    const maquinaId = (result && result.insertId) || null;

    // ===== vínculo (sem aspersor pq essa coluna NÃO existe)
    if (usuario_id != null && maquinaId != null) {
      await withTimeout(
        replaceUserEquipModules(pool, {
          usuario_id: Number(usuario_id),
          maquina_id: Number(maquinaId),
          agua_gelada,
          agua_quente,
          agua_pet,
        }),
        6000,
        "db_timeout"
      );
    }

    return res.status(201).json({
      ok: true,
      id: maquinaId,
      message: "Equipamento cadastrado com sucesso",
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = msg.includes("db_timeout");
    console.error("[POST /equipamentos]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : msg });
  }
});

app.get("/equipamentos/:id/filtros/ultimo", async (req, res) => {
  try {
    const maquinaId = Number(req.params.id);
    if (!Number.isInteger(maquinaId) || maquinaId <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const [rows] = await withTimeout(
      pool.execute(
        `
        SELECT
        COALESCE(f.data, m.data_instalacao) AS data
      FROM maquinas m
      LEFT JOIN filtros f
        ON f.maquina_id = m.id
      WHERE m.id = ?
      ORDER BY f.data DESC, f.updated_at DESC
      LIMIT 1;
        `,
        [maquinaId]
      ),
      4000,
      "db_timeout"
    );

    return res.json({
      ok: true,
      data: rows.length ? rows[0].data : null,
    });
  } catch (e) {
    console.error("[GET /equipamentos/:id/filtros/ultimo]", e);
    return res.status(500).json({ ok: false, error: "Erro ao buscar troca" });
  }
});

app.post("/equipamentos/:id/filtros", async (req, res) => {
  try {
    const maquinaId = Number(req.params.id);
    if (!Number.isInteger(maquinaId) || maquinaId <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const { data, tipo, nome, vazao } = req.body || {};
    if (!data) {
      return res
        .status(400)
        .json({ ok: false, error: "Campo 'data' é obrigatório (YYYY-MM-DD)" });
    }

    // (opcional mas bom) valida se a máquina existe
    const [exists] = await withTimeout(
      pool.execute("SELECT id FROM maquinas WHERE id = ? LIMIT 1", [maquinaId]),
      4000,
      "db_timeout"
    );
    if (!exists.length) {
      return res
        .status(404)
        .json({ ok: false, error: "Equipamento não encontrado." });
    }

    const tipoFinal = String(tipo ?? "-").trim() || "-";
    const nomeFinal = String(nome ?? "-").trim() || "-";
    const vazaoFinal = vazao == null ? null : String(vazao).trim();

    const [result] = await withTimeout(
      pool.execute(
        `
        INSERT INTO filtros (maquina_id, tipo, nome, data, vazao, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [maquinaId, tipoFinal, nomeFinal, data, vazaoFinal]
      ),
      6000,
      "db_timeout"
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      maquina_id: maquinaId,
      message: "Troca de filtro registrada com sucesso",
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = msg.includes("db_timeout");
    console.error("[POST /equipamentos/:id/filtros]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : msg });
  }
});

app.put("/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const body = req.body || {};
    const {
      tipo_id,
      nome,
      serialNumber,
      numeroNotaFiscal,
      numeroSerieEquipamento,
      cidade,
      cidade_nome,
      uf,
      cep,
      bairro,
      endereco,
      numero,
      complemento,
      data_instalacao,
      status,
      observacao,
      usuario_id,
      agua_gelada,
      agua_quente,
      agua_pet,
      aspersor,
    } = body;

    // 1) atualização simples de status
    const onlyStatusUpdate =
      Object.keys(body).length === 1 && typeof status !== "undefined";

    if (onlyStatusUpdate) {
      const code = normalizeStatusToCode(status);
      const [r] = await withTimeout(
        pool.execute(
          "UPDATE maquinas SET status = ?, updated_at = NOW() WHERE id = ? LIMIT 1",
          [code, id]
        ),
        6000,
        "db_timeout"
      );

      if (r.affectedRows === 0) {
        return res.status(404).json({ ok: false, error: "Não encontrado" });
      }

      return res.json({
        ok: true,
        id,
        mode: "status-only",
        message: "Status atualizado com sucesso",
      });
    }

    // 2) atualização completa
    const missing = [];
    if (tipo_id == null) missing.push("tipo_id");
    if (!nome) missing.push("nome");
    if (!serialNumber) missing.push("serialNumber");
    if (!data_instalacao) missing.push("data_instalacao");
    if (status == null) missing.push("status");

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Campos obrigatórios ausentes: ${missing.join(", ")}`,
      });
    }

    const statusCode = normalizeStatusToCode(status);

    // duplicidade de serialNumber
    const [dups] = await withTimeout(
      pool.execute(
        "SELECT id FROM maquinas WHERE TRIM(serialNumber) = TRIM(?) AND id <> ? LIMIT 1",
        [serialNumber, id]
      ),
      4000,
      "db_timeout"
    );

    if (dups.length) {
      return res
        .status(409)
        .json({ ok: false, error: "serialNumber já cadastrado" });
    }

    // ===== Resolver cidade (opcional)
    const cidadeTexto = (cidade ?? cidade_nome ?? "").toString().trim();
    let cidadeId = null;
    let ufFinal =
      String(uf || "")
        .trim()
        .toUpperCase() || null;

    if (cidadeTexto) {
      let nomeCidade = cidadeTexto;
      const slash = cidadeTexto.indexOf("/");

      if (slash > 0) {
        nomeCidade = cidadeTexto.slice(0, slash).trim();
        ufFinal =
          cidadeTexto
            .slice(slash + 1)
            .trim()
            .toUpperCase() || ufFinal;
      }

      try {
        const city = await ensureCityByName(pool, nomeCidade, ufFinal);
        cidadeId = city?.id ?? null;
      } catch (err) {
        const msg = String(err?.message || err);
        if (err && err._badRequest)
          return res.status(400).json({ ok: false, error: msg });
        return res.status(409).json({ ok: false, error: msg });
      }
    }

    // ===== Observacao JSON (merge do que já existe + aspersor)
    // 1) pega observacao atual do banco
    const [curRows] = await withTimeout(
      pool.execute("SELECT observacao FROM maquinas WHERE id = ? LIMIT 1", [
        id,
      ]),
      4000,
      "db_timeout"
    );

    const curObs = curRows?.[0]?.observacao ?? null;

    let mergedObsObj = {};
    try {
      if (curObs && String(curObs).trim()) {
        try {
          const parsed = JSON.parse(String(curObs));
          mergedObsObj =
            parsed && typeof parsed === "object"
              ? parsed
              : { texto: String(curObs) };
        } catch {
          mergedObsObj = { texto: String(curObs) };
        }
      }
    } catch {
      mergedObsObj = {};
    }

    // 2) se o payload trouxe observacao (texto ou json), mescla também
    if (typeof observacao !== "undefined") {
      try {
        if (observacao && String(observacao).trim()) {
          try {
            const parsed = JSON.parse(String(observacao));
            if (parsed && typeof parsed === "object")
              mergedObsObj = { ...mergedObsObj, ...parsed };
            else mergedObsObj.texto = String(observacao);
          } catch {
            mergedObsObj.texto = String(observacao);
          }
        }
      } catch {
        // ignora
      }
    }

    // 3) aplica aspersor se veio no payload (não sobrescreve se não veio)
    if (typeof aspersor !== "undefined") {
      mergedObsObj.aspersor = !!(
        aspersor === true ||
        aspersor === 1 ||
        aspersor === "1"
      );
    }

    const observacaoFinal = Object.keys(mergedObsObj).length
      ? JSON.stringify(mergedObsObj)
      : null;

    // ===== UPDATE maquinas
    const [r] = await withTimeout(
      pool.execute(
        `
        UPDATE maquinas
           SET cidade_id = ?,
               tipo_id = ?,
               nome = ?,
               serialNumber = ?,
               numeroNotaFiscal = ?,
               numeroSerieEquipamento = ?,
               endereco = ?,
               numero = ?,
               bairro = ?,
               cep = ?,
               complemento = ?,
               data_instalacao = ?,
               status = ?,
               observacao = ?,
               updated_at = NOW()
         WHERE id = ?
         LIMIT 1
        `,
        [
          cidadeId,
          Number(tipo_id),
          nome,
          serialNumber,
          numeroNotaFiscal || null,
          numeroSerieEquipamento || null,
          endereco || null,
          numero || null,
          bairro || null,
          cep || null,
          complemento || null,
          data_instalacao,
          statusCode,
          observacaoFinal,
          id,
        ]
      ),
      6000,
      "db_timeout"
    );

    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Não encontrado" });
    }

    // ===== vínculo (sem aspersor pq NÃO existe coluna)
    if (usuario_id != null) {
      await withTimeout(
        replaceUserEquipModules(pool, {
          usuario_id: Number(usuario_id),
          maquina_id: id,
          agua_gelada,
          agua_quente,
          agua_pet,
        }),
        6000,
        "db_timeout"
      );
    }

    return res.json({
      ok: true,
      id,
      mode: "full-update",
      message: "Equipamento atualizado com sucesso",
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = msg.includes("db_timeout");
    console.error("[PUT /equipamentos/:id]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : msg });
  }
});

app.delete("/equipamentos/:id", async (req, res) => {
  const rawId = req.params.id;
  const { hard } = req.query;

  const id = Number(rawId);
  if (!id || Number.isNaN(id)) {
    return res
      .status(400)
      .json({ ok: false, error: "ID inválido para equipamento." });
  }

  const isHard = String(hard) === "1";

  try {
    if (isHard) {
      // =========================
      // DELETE LÓGICO DEFINITIVO
      // =========================
      // status = 3  => "Deletado"
      // remove vínculo com usuário
      // mantém histórico (informacoes)
      // =========================

      const [update] = await withTimeout(
        pool.execute(
          "UPDATE maquinas SET status = 3, updated_at = NOW() WHERE id = ?",
          [id]
        ),
        6000,
        "db_timeout"
      );

      const affected =
        (update && update.affectedRows) ||
        (Array.isArray(update) ? update[0]?.affectedRows : 0);

      if (!affected) {
        return res
          .status(404)
          .json({ ok: false, error: "Equipamento não encontrado." });
      }

      // remove vínculo com cliente (pra sumir do dash)
      await withTimeout(
        pool.execute("DELETE FROM usuarios_equipamentos WHERE maquina_id = ?", [
          id,
        ]),
        6000,
        "db_timeout"
      );

      return res.json({
        ok: true,
        hard: true,
        deleted: true,
        message: "Equipamento removido da visão do cliente.",
      });
    } else {
      // =========================
      // DESATIVAR (status = 2)
      // =========================
      const [result] = await withTimeout(
        pool.execute(
          "UPDATE maquinas SET status = ?, updated_at = NOW() WHERE id = ?",
          ["2", id]
        ),
        6000,
        "db_timeout"
      );

      const affected =
        (result && result.affectedRows) ||
        (Array.isArray(result) ? result[0]?.affectedRows : 0);

      if (!affected) {
        return res
          .status(404)
          .json({ ok: false, error: "Equipamento não encontrado." });
      }

      return res.json({
        ok: true,
        hard: false,
        message: "Equipamento desativado.",
      });
    }
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = msg.includes("db_timeout");
    console.error("[DELETE /equipamentos/:id]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : msg });
  }
});

app.get("/modelos", async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req);
    const sql = `
      SELECT id, nome, created_at, updated_at
      FROM tipos
      ORDER BY id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [rows] = await withTimeout(pool.query(sql), 6000, "db_timeout");
    return res.json({ ok: true, data: rows, limit, offset });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[GET /modelos]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

app.post("/modelos", async (req, res) => {
  try {
    const { nome } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res
        .status(400)
        .json({ ok: false, error: "Campo 'nome' é obrigatório" });
    }

    const [result] = await withTimeout(
      pool.execute(
        `INSERT INTO tipos (nome, created_at, updated_at) VALUES (?, NOW(), NOW())`,
        [String(nome).trim()]
      ),
      6000,
      "db_timeout"
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Modelo cadastrado com sucesso",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[POST /modelos]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : e.message });
  }
});

app.put("/modelos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nome } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }
    if (!nome || !String(nome).trim()) {
      return res
        .status(400)
        .json({ ok: false, error: "Campo 'nome' é obrigatório" });
    }

    const [r] = await withTimeout(
      pool.execute(
        "UPDATE tipos SET nome = ?, updated_at = NOW() WHERE id = ? LIMIT 1",
        [String(nome).trim(), id]
      ),
      6000,
      "db_timeout"
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Não encontrado" });
    }
    return res.json({ ok: true, id, message: "Modelo atualizado com sucesso" });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[PUT /modelos/:id]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

app.delete("/modelos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const [r] = await withTimeout(
      pool.execute("DELETE FROM tipos WHERE id = ? LIMIT 1", [id]),
      6000,
      "db_timeout"
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Não encontrado" });
    }
    return res.json({
      ok: true,
      hard: true,
      message: "Modelo removido definitivamente",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[DELETE /modelos/:id]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : e.message });
  }
});

app.get("/usuarios", async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req);
    const sql = `
      SELECT id, name, email, email_verified_at, photo, type, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [rows] = await withTimeout(pool.query(sql), 6000, "db_timeout");
    return res.json({ ok: true, data: rows, limit, offset });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[GET /usuarios]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

app.post("/usuarios", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      type,
      cidade_id,
      telefone,
      endereco,
      numero,
      bairro,
      cep,
      complemento,
      photo,
      avisos,
      emails_avisos,
    } = req.body || {};

    const missing = [];
    if (!name) missing.push("name");
    if (!email) missing.push("email");
    if (!password) missing.push("password");
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Campos obrigatórios ausentes: ${missing.join(", ")}`,
      });
    }

    const hash = await bcrypt.hash(String(password), 10);

    const [result] = await withTimeout(
      pool.execute(
        `
        INSERT INTO users
          (cidade_id, name, email, email_verified_at, password, telefone, endereco, numero, bairro, cep, complemento, type, photo, remember_token, created_at, updated_at, avisos, emails_avisos)
        VALUES
          (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW(), NOW(), ?, ?)
        `,
        [
          cidade_id ?? null,
          String(name).trim(),
          String(email).trim(),
          hash,
          telefone ?? null,
          endereco ?? null,
          numero ?? null,
          bairro ?? null,
          cep ?? null,
          complemento ?? null,
          type == null ? null : Number(type),
          photo ?? null,
          avisos == null ? 1 : Number(avisos) ? 1 : 0,
          emails_avisos ?? null,
        ]
      ),
      8000,
      "db_timeout"
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Usuário cadastrado com sucesso",
    });
  } catch (e) {
    if (e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)) {
      return res.status(409).json({ ok: false, error: "E-mail já cadastrado" });
    }
    const msg = String((e && e.message) || "");
    const isTimeout = msg.includes("db_timeout");
    console.error("[POST /usuarios]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : msg });
  }
});

app.put("/usuarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const {
      name,
      email,
      password,
      type,
      photo,
      cidade_id,
      telefone,
      endereco,
      numero,
      bairro,
      cep,
      complemento,
      avisos,
      emails_avisos,
    } = req.body || {};

    const fields = [];
    const params = [];

    if (name != null) {
      fields.push("name = ?");
      params.push(String(name).trim());
    }
    if (email != null) {
      fields.push("email = ?");
      params.push(String(email).trim());
    }
    if (type != null) {
      fields.push("type = ?");
      params.push(Number(type));
    }
    if (photo !== undefined) {
      fields.push("photo = ?");
      params.push(photo ?? null);
    }
    if (cidade_id !== undefined) {
      fields.push("cidade_id = ?");
      params.push(cidade_id ?? null);
    }
    if (telefone !== undefined) {
      fields.push("telefone = ?");
      params.push(telefone ?? null);
    }
    if (endereco !== undefined) {
      fields.push("endereco = ?");
      params.push(endereco ?? null);
    }
    if (numero !== undefined) {
      fields.push("numero = ?");
      params.push(numero ?? null);
    }
    if (bairro !== undefined) {
      fields.push("bairro = ?");
      params.push(bairro ?? null);
    }
    if (cep !== undefined) {
      fields.push("cep = ?");
      params.push(cep ?? null);
    }
    if (complemento !== undefined) {
      fields.push("complemento = ?");
      params.push(complemento ?? null);
    }
    if (avisos !== undefined) {
      fields.push("avisos = ?");
      params.push(avisos ? 1 : 0);
    }
    if (emails_avisos !== undefined) {
      fields.push("emails_avisos = ?");
      params.push(emails_avisos ?? null);
    }

    if (password) {
      const hash = await bcrypt.hash(String(password), 10);
      fields.push("password = ?");
      params.push(hash);
    }

    if (fields.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Nenhum campo para atualizar" });
    }

    fields.push("updated_at = NOW()");
    params.push(id);

    const [r] = await withTimeout(
      pool.execute(
        `UPDATE users SET ${fields.join(", ")} WHERE id = ? LIMIT 1`,
        params
      ),
      8000,
      "db_timeout"
    );

    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Não encontrado" });
    }
    return res.json({
      ok: true,
      id,
      message: "Usuário atualizado com sucesso",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[PUT /usuarios/:id]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

app.delete("/usuarios/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "ID inválido" });
  }

  try {
    // 1️⃣ remove vínculos com equipamentos
    await withTimeout(
      pool.execute("DELETE FROM usuarios_equipamentos WHERE usuario_id = ?", [
        id,
      ]),
      8000,
      "db_timeout"
    );

    // 2️⃣ remove o usuário definitivamente
    const [r] = await withTimeout(
      pool.execute("DELETE FROM users WHERE id = ? LIMIT 1", [id]),
      8000,
      "db_timeout"
    );

    if (r.affectedRows === 0) {
      return res.status(404).json({
        ok: false,
        error: "Usuário não encontrado",
      });
    }

    return res.json({
      ok: true,
      message: "Usuário removido com sucesso",
    });
  } catch (e) {
    console.error("[DELETE /usuarios/:id]", e);
    return res.status(500).json({
      ok: false,
      error: "Erro ao remover usuário",
    });
  }
});

// ===== start
const port = Number(process.env.PORT || 8080);
const host = "0.0.0.0";

const server = app.listen(port, host, () => {
  console.log(`ICEHOT API rodando em http://${host}:${port}`);
});

server.on("listening", () => {
  console.log("[listen] ok");
});

server.on("error", (err) => {
  console.error("[listen] erro:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
