import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { PortfolioService } from '../services/portfolioService';

const prisma = new PrismaClient();
const portfolioService = new PortfolioService(prisma);

export const getUserPortfolio = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.query;
  
  if (!userId || typeof userId !== 'string') {
    throw createError('User ID is required', 400);
  }

  const portfolio = await portfolioService.getPortfolio(parseInt(userId));
  
  res.json({
    success: true,
    data: portfolio,
    timestamp: new Date().toISOString()
  });
});

export const getUserPortfolioWithDetails = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.query;
  
  if (!userId || typeof userId !== 'string') {
    throw createError('User ID is required', 400);
  }

  const portfolio = await portfolioService.getPortfolioWithDetails(parseInt(userId));
  
  res.json({
    success: true,
    data: portfolio,
    timestamp: new Date().toISOString()
  });
});