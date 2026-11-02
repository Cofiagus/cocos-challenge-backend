import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/environment';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { healthCheck } from './controllers/healthController';
import { portfolioRouter } from './controllers/portfolioController';
import { instrumentRouter } from './controllers/instrumentController';
import { orderRouter } from './controllers/orderController';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? config.productionOrigin : '*',
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(requestLogger);

// Health check endpoint
app.get('/health', healthCheck);

// API routes
app.get('/api', (req, res) => {
  res.json({
    message: 'Cocos Challenge Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      portfolio: '/api/users/portfolio',
      instruments: '/api/instruments',
      orders: '/api/orders'
    }
  });
});

// API routes
app.use('/api/users/portfolio', portfolioRouter);
app.use('/api/instruments', instrumentRouter);
app.use('/api/orders', orderRouter);

// Error handling middleware (must be last)
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 Server running on port ${config.port}`);
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`🔗 Database: ${config.databaseUrl.split('@')[1]}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

export default app;