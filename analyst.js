'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');
const { AnalystCredentialManager } = require('./utils/analyst/analyst-credentials');
const { AnalystService } = require('./utils/analyst/analyst-service');
const { AnalystScheduler } = require('./utils/analyst/analyst-scheduler');
const { registerAnalystRoutes } = require('./utils/analyst/analyst-router');
const { analystHost, assertSafeAnalystBinding } = require('./utils/analyst-mode');

class AgentTubeAnalystApp {
  constructor() {
    this.logger = new Logger('AnalystApp');
    this.app = express();
    this.db = null;
    this.credentials = null;
    this.analyst = null;
    this.analystScheduler = null;
  }

  requireAPIKey() {
    return (req, res, next) => {
      const configured = String(process.env.API_KEY || '').trim();
      if (!configured) return next();
      if (req.get('x-api-key') !== configured) return res.status(401).json({ success: false, error: 'Unauthorized' });
      return next();
    };
  }

  async initialize() {
    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    this.db = new Database();
    await this.db.initialize();

    this.credentials = new AnalystCredentialManager();
    await this.credentials.initialize();

    this.analyst = new AnalystService(this.db, this.credentials, { logger: this.logger });
    await this.analyst.initialize();

    this.analystScheduler = new AnalystScheduler(this.analyst, this.db, { logger: this.logger });
    await this.analystScheduler.initialize();
    if (await this.db.getSetting('analyst_automation_paused') === 'true') await this.analystScheduler.pauseAutomation();

    this.app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'analyst.html')));
    this.app.get('/analyst', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'analyst.html')));
    this.app.get('/health', (_req, res) => res.json({ status: 'healthy', mode: 'analyst-sidecar', readOnly: true, schedulerEnabled: this.analystScheduler.isEnabled }));
    registerAnalystRoutes(this);
    return true;
  }

  async start() {
    await this.initialize();
    const port = Number(process.env.ANALYST_PORT || process.env.PORT || 3456);
    const host = assertSafeAnalystBinding(analystHost());
    this.app.listen(port, host, () => {
      console.log(`\nAgentTube Analyst is running at http://${host}:${port}`);
      console.log('YouTube access is read-only. AgentTube publishing/production services are not initialized.');
    });
  }
}

if (require.main === module) {
  new AgentTubeAnalystApp().start().catch(error => {
    console.error(`Analyst startup failed: ${error.message}`);
    if (error.code) console.error(`Code: ${error.code}`);
    process.exitCode = 1;
  });
}

module.exports = { AgentTubeAnalystApp };
