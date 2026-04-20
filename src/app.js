const express = require("express");
const path = require("path");
const session = require("express-session");
const cors = require("cors");

const { requireAuth } = require("./middleware/requireAuth");

const authRoutes = require("./routes/auth.routes");
const apiRoutes = require("./routes/api");

function createApp() {
  const app = express();

  // Middlewares (mesma ordem/efeito do original)
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      secret: process.env.SESSION_SECRET || "change-me-in-production",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // desenvolvimento (mantido)
        maxAge: 24 * 60 * 60 * 1000, // 24 horas
      },
    })
  );

  // Diagnóstico geral (mantido)
  app.use((req, res, next) => {
    console.log(`[DIAGNÓSTICO GERAL] - URL Recebida: ${req.method} ${req.originalUrl}`);
    next();
  });

  // Estáticos (pasta /public na raiz do projeto)
  app.use(express.static(path.join(process.cwd(), "public")));

  // Rotas públicas
  app.use(authRoutes);

  // Rotas protegidas
  app.use("/api", requireAuth, apiRoutes);

  return app;
}

module.exports = { createApp };
