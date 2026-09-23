'use strict';

function registerAnalystRoutes(agent) {
  if (!agent?.app) throw new Error('registerAnalystRoutes requires the AgentTube application instance');
  const protect = agent.requireAPIKey();
  const service = () => agent.analyst;
  const unavailable = res => res.status(503).json({ success: false, error: 'Analyst Mode is not initialized' });

  agent.app.post('/api/analyst/sync', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const result = await service().syncCatalog({
        maxVideos: req.body?.maxVideos,
        resolveContentTypes: req.body?.resolveContentTypes !== false
      });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  agent.app.post('/api/analyst/measure', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const result = await service().collectDueMeasurements({
        limit: req.body?.limit,
        videoScanLimit: req.body?.videoScanLimit
      });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  agent.app.get('/api/analyst/summary', async (_req, res) => {
    try {
      if (!service()) return unavailable(res);
      return res.json({ success: true, result: await service().getSummary() });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  agent.app.get('/api/analyst/videos', async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 500)));
      const result = await service().repository.listVideos({ limit });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  agent.app.get('/api/analyst/videos/:videoId/diagnosis', async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      if (!validVideoId(req.params.videoId)) return res.status(400).json({ success: false, error: 'Invalid video ID' });
      const result = await service().getVideoDiagnosis(req.params.videoId, String(req.query.window || '28d'));
      if (!result) return res.status(404).json({ success: false, error: 'Video not found in analyst catalog' });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  // Retention curves consume YouTube Analytics quota, so refresh/fetch is protected
  // and explicitly operator-triggered. Results are cached locally by window.
  agent.app.post('/api/analyst/videos/:videoId/retention', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      if (!validVideoId(req.params.videoId)) return res.status(400).json({ success: false, error: 'Invalid video ID' });
      const result = await service().getRetentionAnalysis(
        req.params.videoId,
        String(req.body?.window || '28d'),
        { refresh: req.body?.refresh === true }
      );
      if (!result) return res.status(404).json({ success: false, error: 'Video not found in analyst catalog' });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  // AI advice is deliberately on-demand. Background catalog/analytics jobs do not
  // spend Gemini quota simply because a scheduler ran.
  agent.app.post('/api/analyst/videos/:videoId/advice', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      if (!validVideoId(req.params.videoId)) return res.status(400).json({ success: false, error: 'Invalid video ID' });
      const result = await service().getAdvice(req.params.videoId, String(req.body?.window || '28d'));
      if (!result) return res.status(404).json({ success: false, error: 'Video not found in analyst catalog' });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  agent.app.get('/api/analyst/recommendations', async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const result = await service().listRecommendations({
        status: req.query.status ? String(req.query.status) : undefined,
        videoId: req.query.videoId ? String(req.query.videoId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 100
      });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  agent.app.patch('/api/analyst/recommendations/:id', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const result = await service().setRecommendationStatus(req.params.id, String(req.body?.status || ''), {
        note: req.body?.note,
        appliedAt: req.body?.appliedAt,
        deferredUntil: req.body?.deferredUntil
      });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
  });

  agent.app.post('/api/analyst/recommendations/:id/evaluate', protect, async (req, res) => {
    try {
      if (!service()) return unavailable(res);
      const result = await service().evaluateRecommendation(req.params.id);
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
    }
  });

  agent.app.get('/api/analyst/upstream-update', async (_req, res) => {
    try {
      if (!agent.analystScheduler) return res.status(503).json({ success: false, error: 'Analyst scheduler is not initialized' });
      return res.json({ success: true, result: await agent.analystScheduler.updateChecker.getLastCheck() });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  agent.app.post('/api/analyst/upstream-update/check', protect, async (_req, res) => {
    try {
      if (!agent.analystScheduler) return res.status(503).json({ success: false, error: 'Analyst scheduler is not initialized' });
      const result = await agent.analystScheduler.runLocked('upstream-update-check', () => agent.analystScheduler.runUpdateCheck());
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  agent.app.post('/api/analyst/scheduler/:action', protect, async (req, res) => {
    try {
      if (!agent.analystScheduler) return res.status(503).json({ success: false, error: 'Analyst scheduler is not initialized' });
      const action = String(req.params.action || '');
      if (action === 'pause') await agent.analystScheduler.pauseAutomation();
      else if (action === 'resume') await agent.analystScheduler.resumeAutomation();
      else return res.status(400).json({ success: false, error: 'Action must be pause or resume' });
      await agent.db.setSetting('analyst_automation_paused', String(action === 'pause'));
      return res.json({ success: true, paused: !agent.analystScheduler.isEnabled });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}

function validVideoId(value) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(String(value || ''));
}

module.exports = { registerAnalystRoutes, validVideoId };
