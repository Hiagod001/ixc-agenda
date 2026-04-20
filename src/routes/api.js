const express = require("express");

const userRoutes = require("./api.user.routes");
const configRoutes = require("./api.config.routes");
const agRoutes = require("./api.agendamentos.routes");
const usersRoutes = require("./api.users.routes");
const logsRoutes = require("./api.logs.routes");
const ixcRoutes = require("./api.ixc.routes");
const subjectsRoutes = require("./api.subjects.routes");
const vacancyTemplatesRoutes = require("./api.vacancyTemplates.routes");
const reportsRoutes = require("./api.reports.routes");
const auditRoutes = require("./api.audit.routes");
const techniciansRoutes = require("./api.technicians.routes");
const citiesRoutes = require("./api.cities.routes");

const router = express.Router();

// Rotas agrupadas (todas são montadas em /api no app.js)
router.use(userRoutes);
router.use(configRoutes);
router.use(agRoutes);
router.use(usersRoutes);
router.use(logsRoutes);
router.use(ixcRoutes);
router.use(subjectsRoutes);
router.use(vacancyTemplatesRoutes);
router.use(reportsRoutes);
router.use(auditRoutes);
router.use(techniciansRoutes);
router.use(citiesRoutes);

module.exports = router;
