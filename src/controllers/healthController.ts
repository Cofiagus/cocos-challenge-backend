import { Request, Response } from 'express';

export const healthCheck = (req: Request, res: Response) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0',
    database: 'connected', // TODO: Add actual database health check
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100,
      percentage: Math.round(process.memoryUsage().heapUsed / process.memoryUsage().heapTotal * 100)
    }
  };

  res.json(health);
};