const axios = require("axios");

// Configuracao da API IXC via ambiente ou painel interno.
let ixcApi = null;
const ixcConfig = {
  apiUrl: (process.env.IXC_URL || "").trim(),
  apiToken: (process.env.IXC_TOKEN || "").trim(),
};

function initializeIxcApi() {
  if (ixcConfig.apiToken && ixcConfig.apiUrl) {
    const basicAuthToken = Buffer.from(ixcConfig.apiToken).toString("base64");
    ixcApi = axios.create({
      baseURL: ixcConfig.apiUrl,
      headers: {
        Authorization: `Basic ${basicAuthToken}`,
        "Content-Type": "application/json",
        ixcsoft: "listar",
      },
      timeout: 20000,
    });
    console.log("API IXC inicializada com sucesso");
  } else {
    ixcApi = null;
    console.log("API IXC nao configurada");
  }
}

function getIxcApi() {
  return ixcApi;
}

function getIxcConfig() {
  return { ...ixcConfig };
}

function setIxcConfig({ apiUrl, apiToken }) {
  if (typeof apiUrl === "string") ixcConfig.apiUrl = apiUrl.trim();
  if (typeof apiToken === "string") ixcConfig.apiToken = apiToken.trim();
  initializeIxcApi();
}

module.exports = { initializeIxcApi, getIxcApi, ixcConfig, getIxcConfig, setIxcConfig };
