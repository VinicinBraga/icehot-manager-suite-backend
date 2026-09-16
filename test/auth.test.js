process.env.JWT_SECRET = "test-only-secret-which-is-not-production";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://frontend.test";
process.env.RATE_LIMIT_LOGIN_MAX = "10";
process.env.RATE_LIMIT_LOGIN_WINDOW_MS = "60000";
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, pool } = require("../index");

const passwordHash = bcrypt.hashSync("correct-password", 10);
pool.execute = async (sql) => sql.includes("FROM users WHERE email") ? [[{ id: 7, name: "Test", email: "user@test.invalid", password: passwordHash, type: 1, photo: null }]] : sql.includes("INSERT INTO tipos") ? [{ insertId: 42 }] : [[]];
pool.query = async (sql) => sql.includes("FROM users") ? [[{ id: 7, name: "Test", email: "user@test.invalid", type: 1, password: passwordHash }]] : [[]];

test("login válido retorna token sem expor senha", async () => {
  const res = await request(app).post("/auth/login").send({ email: "user@test.invalid", password: "correct-password" });
  assert.equal(res.status, 200); assert.ok(res.body.token); assert.equal(res.body.user.password, undefined);
});
test("credenciais inválidas têm resposta genérica", async () => {
  const res = await request(app).post("/auth/login").send({ email: "missing@test.invalid", password: "wrong" });
  assert.equal(res.status, 401); assert.equal(res.body.error, "Credenciais inválidas");
});
test("rotas protegidas rejeitam token ausente ou inválido", async () => {
  assert.equal((await request(app).get("/auth/me")).status, 401);
  assert.equal((await request(app).get("/auth/me").set("Authorization", "Bearer invalid")).status, 401);
});
test("auth/me aceita JWT válido e rejeita expirado", async () => {
  const token = jwt.sign({ sub: "7", email: "user@test.invalid", type: 1 }, process.env.JWT_SECRET, { expiresIn: "1h", issuer: "icehot-api", audience: "icehot-manager-suite" });
  assert.equal((await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`)).status, 200);
  const expired = jwt.sign({ sub: "7", type: 1 }, process.env.JWT_SECRET, { expiresIn: -1, issuer: "icehot-api", audience: "icehot-manager-suite" });
  assert.equal((await request(app).get("/auth/me").set("Authorization", `Bearer ${expired}`)).status, 401);
});
test("CORS permite allowlist e rejeita origem desconhecida", async () => {
  assert.equal((await request(app).options("/health").set("Origin", "https://frontend.test")).status, 204);
  assert.equal((await request(app).options("/health").set("Origin", "https://evil.invalid")).status, 500);
});
test("login aplica rate limit", async () => {
  const responses = [];
  for (let i = 0; i < 11; i++) responses.push(await request(app).post("/auth/login").send({ email: `x${i}`, password: "x" }));
  assert.equal(responses.at(-1).status, 429);
});
test("Admin executa mutação e cliente recebe 403", async () => {
  const admin = jwt.sign({ sub: "7", email: "a@test.invalid", type: 1 }, process.env.JWT_SECRET, { issuer: "icehot-api", audience: "icehot-manager-suite", expiresIn: "1h" });
  const client = jwt.sign({ sub: "8", email: "c@test.invalid", type: 2 }, process.env.JWT_SECRET, { issuer: "icehot-api", audience: "icehot-manager-suite", expiresIn: "1h" });
  assert.equal((await request(app).post("/modelos").set("Authorization", `Bearer ${admin}`).send({ nome: "Novo" })).status, 201);
  assert.equal((await request(app).post("/modelos").set("Authorization", `Bearer ${client}`).send({ nome: "Novo" })).status, 403);
});
test("GET /usuarios não retorna password", async () => {
  const admin = jwt.sign({ sub: "7", email: "a@test.invalid", type: 1 }, process.env.JWT_SECRET, { issuer: "icehot-api", audience: "icehot-manager-suite", expiresIn: "1h" });
  const res = await request(app).get("/usuarios").set("Authorization", `Bearer ${admin}`);
  assert.equal(res.status, 200); assert.equal(res.body.data[0].password, undefined);
});
test("/diag fica indisponível em produção", async () => {
  process.env.NODE_ENV = "production";
  const token = jwt.sign({ sub: "7", type: 1 }, process.env.JWT_SECRET, { issuer: "icehot-api", audience: "icehot-manager-suite", expiresIn: "1h" });
  assert.equal((await request(app).get("/diag").set("Authorization", `Bearer ${token}`)).status, 404);
  process.env.NODE_ENV = "test";
});
