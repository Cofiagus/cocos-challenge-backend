import { Request, Response, NextFunction } from 'express';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, originalUrl, ip } = req;
    const { statusCode } = res;
    
    console.log(`${method} ${originalUrl} ${statusCode} - ${ip} - ${duration}ms`);
    
    // Log warnings for slow requests
    if (duration > 1000) {
      console.warn(`Slow request: ${method} ${originalUrl} took ${duration}ms`);
    }
  });
  
  next();
};