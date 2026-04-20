// Constantes e estrutura padrao de vagas

const cidades = ["CIDADE MODELO A", "CIDADE MODELO B", "CIDADE MODELO C"];
const tecnicos = ["Tecnico 01", "Tecnico 02", "Tecnico 03", "A definir"];
const statusPossiveis = ["Aberta", "Agendada", "Em andamento", "Concluida", "Cancelada"];
const assuntos = ["SEM CONEXAO", "CONEXAO LENTA", "AGENDAMENTO", "INSTALACAO", "MANUTENCAO"];
const tiposOS = ["FIBRA", "RADIO"];

const ESTRUTURA_VAGAS = {
  "CIDADE MODELO A": {
    FIBRA: {
      MANHA: { "SEM CONEXAO": 5, "CONEXAO LENTA": 2, AGENDAMENTO: 3 },
      TARDE: { "SEM CONEXAO": 5, "CONEXAO LENTA": 2, AGENDAMENTO: 3 },
    },
    RADIO: {
      MANHA: { "SEM CONEXAO": 2, "CONEXAO LENTA": 1, AGENDAMENTO: 2 },
      TARDE: { "SEM CONEXAO": 2, "CONEXAO LENTA": 1, AGENDAMENTO: 2 },
    },
  },
  "CIDADE MODELO B": {
    FIBRA: {
      MANHA: { "SEM CONEXAO": 3, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
      TARDE: { "SEM CONEXAO": 3, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
    },
    RADIO: {
      MANHA: { "SEM CONEXAO": 1, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
      TARDE: { "SEM CONEXAO": 1, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
    },
  },
  "CIDADE MODELO C": {
    FIBRA: {
      MANHA: { "SEM CONEXAO": 3, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
      TARDE: { "SEM CONEXAO": 3, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
    },
    RADIO: {
      MANHA: { "SEM CONEXAO": 1, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
      TARDE: { "SEM CONEXAO": 1, "CONEXAO LENTA": 1, AGENDAMENTO: 1 },
    },
  },
};

module.exports = { cidades, tecnicos, statusPossiveis, assuntos, tiposOS, ESTRUTURA_VAGAS };
