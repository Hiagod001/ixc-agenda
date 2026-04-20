# IXC Agenda

Aplicacao web para gerenciar agenda de ordens de servico com Node.js, Express, SQLite e integracao opcional com IXC.

## Como executar

```bash
npm install
cp .env.example .env
npm start
```

Por padrao, a aplicacao sobe em `http://localhost:3001`.

## Variaveis de ambiente

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

Se `INIT_ADMIN_PASSWORD` nao for definido e o banco estiver vazio, o sistema gera uma senha temporaria no log de inicializacao.

## O que fica fora do git

- `.env`
- `agenda.db`, `agenda.db-shm`, `agenda.db-wal`
- logs
- `public/logo.png`

## Observacoes

- A integracao IXC pode ser configurada por ambiente ou pela interface da aplicacao.
- O repositório foi higienizado para publicacao sem dados operacionais reais, credenciais conhecidas ou marca privada.
