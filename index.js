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
    allowedHeaders: ["Content-Type", "Authorization"],
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
  connectTimeout: 8000, // 8s para abrir conexão
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
  return 0; // default seguro
}

// ===== /ping: sem DB (para testar o servidor)
app.get("/ping", (_req, res) => {
  res.type("text").send("pong");
});

// ===== /diag: ver env lidas e testar conexão simples (sem expor senha)
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

// ===== /health: tenta falar com o DB mas não trava a resposta
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

/* =============================================================================
 * EQUIPAMENTOS
 * ========================================================================== */

/** GET /equipamentos — lista maquinas (com paginação) */
app.get("/equipamentos", async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req);
    const sql = `
      SELECT
        m.id, m.nome, m.serialNumber, m.numeroNotaFiscal, m.numeroSerieEquipamento,
        m.tipo_id, m.cidade_id, c.nome AS cidade_nome,
        m.cep, m.bairro, m.endereco, m.numero, m.complemento,
        m.data_instalacao, m.status, m.observacao, m.created_at, m.updated_at
      FROM maquinas m
      LEFT JOIN cidades c ON c.id = m.cidade_id
      ORDER BY m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [rows] = await withTimeout(pool.query(sql), 6000, "db_timeout");
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

/**
 * POST /equipamentos
 * Campos mapeados 1:1 com a tabela `maquinas`.
 */
app.post("/equipamentos", async (req, res) => {
  try {
    const {
      tipo_id,
      nome,
      serialNumber,
      numeroNotaFiscal,
      numeroSerieEquipamento,
      cidade, // aceita 'cidade' (ou 'cidade_nome')
      cidade_nome,
      cep,
      bairro,
      endereco,
      numero,
      complemento,
      data_instalacao,
      status,
      observacao,
    } = req.body || {};

    const missing = [];
    if (tipo_id == null) missing.push("tipo_id");
    if (!nome) missing.push("nome");
    if (!serialNumber) missing.push("serialNumber");
    if (!data_instalacao) missing.push("data_instalacao");
    // aceita 0 (falsy) sem marcar como ausente
    if (status == null) missing.push("status");

    const cidadeTexto = (cidade ?? cidade_nome ?? "").toString().trim();
    if (!cidadeTexto) missing.push("cidade");
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
        "SELECT id FROM maquinas WHERE TRIM(serialNumber)=TRIM(?) LIMIT 1",
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

    // ===== Resolver cidade (nome -> id) na tabela 'cidades' =====
    // Suporta "Cidade/UF" (ex.: "Belo Horizonte/MG")
    let nomeCidade = cidadeTexto,
      uf = null;
    const slash = cidadeTexto.indexOf("/");
    if (slash > 0) {
      nomeCidade = cidadeTexto.slice(0, slash).trim();
      uf = cidadeTexto.slice(slash + 1).trim();
    }

    let cidadeId = null;
    if (uf) {
      // match por nome + UF
      const [rowsUF] = await withTimeout(
        pool.execute(
          "SELECT id FROM cidades WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) AND UPPER(TRIM(uf)) = UPPER(TRIM(?)) LIMIT 2",
          [nomeCidade, uf]
        ),
        4000,
        "db_timeout"
      );
      if (rowsUF.length === 1) {
        cidadeId = rowsUF[0].id;
      } else if (rowsUF.length > 1) {
        return res.status(409).json({
          ok: false,
          error: `Cidade ambígua: existe mais de uma "${nomeCidade}/${uf}".`,
        });
      }
    }

    if (!cidadeId) {
      // match exato por nome (sem UF)
      const [rowsExact] = await withTimeout(
        pool.execute(
          "SELECT id FROM cidades WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) LIMIT 2",
          [nomeCidade]
        ),
        4000,
        "db_timeout"
      );
      if (rowsExact.length === 1) {
        cidadeId = rowsExact[0].id;
      } else if (rowsExact.length > 1) {
        return res.status(409).json({
          ok: false,
          error: `Cidade ambígua para "${nomeCidade}". Especifique UF (ex.: "${nomeCidade}/UF").`,
        });
      } else {
        // fallback: LIKE
        const [rowsLike] = await withTimeout(
          pool.execute(
            "SELECT id FROM cidades WHERE nome LIKE ? ORDER BY nome LIMIT 2",
            [`${nomeCidade}%`]
          ),
          4000,
          "db_timeout"
        );
        if (rowsLike.length === 1) {
          cidadeId = rowsLike[0].id;
        } else if (rowsLike.length > 1) {
          return res.status(409).json({
            ok: false,
            error: `Cidade ambígua: várias cidades começam com "${nomeCidade}". Especifique UF.`,
          });
        } else {
          return res.status(404).json({
            ok: false,
            error: `Cidade "${cidadeTexto}" não encontrada.`,
          });
        }
      }
    }

    // ===== INSERT mantendo o schema (cidade_id) =====
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
          Number(cidadeId),
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
          statusCode, // <<< grava 0/1/2
          observacao || null,
        ]
      ),
      6000,
      "db_timeout"
    );

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Equipamento cadastrado com sucesso",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[POST /equipamentos]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : e.message });
  }
});

/** PUT /equipamentos/:id — atualizar status (0/1/2) */
app.put("/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    let { status } = req.body || {};
    const updates = [];
    const params = [];

    if (status !== undefined) {
      const code = normalizeStatusToCode(status);
      updates.push("status = ?");
      params.push(code);
    }

    if (updates.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Nenhum campo para atualizar" });
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    const [r] = await withTimeout(
      pool.execute(
        `UPDATE maquinas SET ${updates.join(", ")} WHERE id = ? LIMIT 1`,
        params
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
      message: "Equipamento atualizado com sucesso",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[PUT /equipamentos/:id]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
    });
  }
});

/**
 * DELETE /equipamentos/:id
 * Soft delete: status = 2 (Desativado), mantém histórico.
 * ?hard=1 => hard delete (apenas para DEV/teste)
 */
app.delete("/equipamentos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const hard = String(req.query.hard || "0") === "1";

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    if (hard) {
      const [result] = await withTimeout(
        pool.execute("DELETE FROM maquinas WHERE id = ? LIMIT 1", [id]),
        6000,
        "db_timeout"
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ ok: false, error: "Não encontrado" });
      }
      return res.json({
        ok: true,
        hard: true,
        message: "Equipamento removido definitivamente",
      });
    }

    const [result] = await withTimeout(
      pool.execute(
        "UPDATE maquinas SET status = 2, updated_at = NOW() WHERE id = ? LIMIT 1",
        [id]
      ),
      6000,
      "db_timeout"
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Não encontrado" });
    }
    return res.json({
      ok: true,
      hard: false,
      message: "Equipamento movido para a lixeira",
    });
  } catch (e) {
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[DELETE /equipamentos/:id]", e);
    return res
      .status(isTimeout ? 504 : 500)
      .json({ ok: false, error: isTimeout ? "MySQL timeout" : e.message });
  }
});

/* =============================================================================
 * MODELOS (tipos)
 * ========================================================================== */

/** GET /modelos — lista tipos (com paginação) */
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

/** POST /modelos — cria tipo */
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

/** PUT /modelos/:id — atualiza nome do tipo */
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

/** DELETE /modelos/:id — hard delete (tipos não tem deleted_at) */
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

/* =============================================================================
 * USUÁRIOS (users)
 * ========================================================================== */

/** GET /usuarios — lista usuários (com paginação) */
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

/**
 * POST /usuarios
 * Grava na tabela `users`.
 */
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

/** PUT /usuarios/:id — update parcial (hash de senha se enviado) */
app.put("/usuarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }

    const {
      name,
      email,
      password, // opcional
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
    if (e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)) {
      return res.status(409).json({ ok: false, error: "E-mail já cadastrado" });
    }
    const isTimeout = e && String(e.message).includes("db_timeout");
    console.error("[PUT /usuarios/:id]", e);
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      error: isTimeout ? "MySQL timeout" : String(e.message || e),
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
