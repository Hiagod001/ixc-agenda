# IXC Agenda

![Node.js](https://img.shields.io/badge/Node.js-14%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-API-111111?style=for-the-badge&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-local-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![IXC](https://img.shields.io/badge/IXC-integra%C3%A7%C3%A3o-0A66C2?style=for-the-badge)

Aplicação web para gerenciar agenda de ordens de serviço com Node.js, Express, SQLite e integração opcional com o IXC.

## Visão Geral

O IXC Agenda organiza vagas, agendamentos, usuários e relatórios em uma interface web voltada para operação técnica. A integração com IXC pode ser configurada por ambiente ou pela própria aplicação, mantendo o sistema flexível para uso interno.

## Recursos

- Gestão de agendamentos de ordens de serviço.
- Controle de vagas por cidade, período e equipe.
- Autenticação de usuários.
- Relatórios e consultas operacionais.
- Integração opcional com IXC.
- Banco SQLite local.
- Smoke test para validação rápida.

<details>
<summary>Fluxo de operação</summary>

1. Configure ambiente, banco e credenciais iniciais.
2. Cadastre usuários e parâmetros de agenda.
3. Consulte disponibilidade de vagas.
4. Registre ou ajuste agendamentos.
5. Use relatórios para acompanhar a operação.

</details>

## Stack

| Camada | Tecnologia |
| --- | --- |
| Backend | Node.js, Express |
| Banco | SQLite |
| Integração | Axios + API IXC |
| Segurança | bcrypt, sessão Express, CORS |
| Desenvolvimento | Nodemon |

## Instalação

```bash
npm install
cp .env.example .env
```

Edite o `.env` conforme o ambiente:

```env
PORT=3001
NODE_ENV=development
SESSION_SECRET=change-me
INIT_ADMIN_USERNAME=admin
INIT_ADMIN_PASSWORD=troque-esta-senha
IXC_URL=
IXC_TOKEN=
DB_PATH=./agenda.db
```

## Execução

```bash
npm start
```

Modo desenvolvimento:

```bash
npm run dev
```

Endereço padrão:

```text
http://localhost:3001
```

## Teste Rápido

```bash
npm test
```

## Segurança

- Não versionar `.env`.
- Usar `SESSION_SECRET` forte em produção.
- Trocar a senha inicial do admin.
- Proteger tokens IXC fora do repositório.

<details>
<summary>Arquivos que ficam fora do Git</summary>

- `.env`
- `agenda.db`
- `agenda.db-shm`
- `agenda.db-wal`
- logs
- arquivos operacionais reais

</details>
