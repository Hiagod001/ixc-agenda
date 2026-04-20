require("dotenv").config();

const { createApp } = require("./app");
const { db } = require("./db/connection");
const { initializeDatabase } = require("./db/init");
const { initializeIxcApi } = require("./services/ixc");

const port = process.env.PORT || 3001;

async function startServer() {
  try {
    // Inicializa IXC com defaults (igual ao original)
    initializeIxcApi();

    await initializeDatabase(db);

    const app = createApp();
    app.listen(port, () => {
      console.log(`Servidor Agenda rodando em http://localhost:${port}`);
      console.log(`Ambiente: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("Erro ao inicializar servidor:", error);
    process.exitCode = 1;
  }
}

startServer();
