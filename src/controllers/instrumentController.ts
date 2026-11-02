import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { asyncHandler, createError } from '../middleware/errorHandler';

const prisma = new PrismaClient();

export const searchInstruments = asyncHandler(async (req: Request, res: Response) => {
  const { q } = req.query;
  
  if (!q || typeof q !== 'string') {
    throw createError('Search query is required', 400);
  }

  const instruments = await prisma.instrument.findMany({
    where: {
      OR: [
        { ticker: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } }
      ]
    },
    take: 20,
    orderBy: [
      { ticker: 'asc' },
      { name: 'asc' }
    ]
  });

  res.json({
    success: true,
    data: instruments,
    query: q,
    count: instruments.length,
    timestamp: new Date().toISOString()
  });
});

export const getInstrumentById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  if (!id || isNaN(parseInt(id))) {
    throw createError('Valid instrument ID is required', 400);
  }

  const instrument = await prisma.instrument.findUnique({
    where: { id: parseInt(id) },
    include: {
      marketData: {
        orderBy: { date: 'desc' },
        take: 30
      }
    }
  });

  if (!instrument) {
    throw createError('Instrument not found', 404);
  }

  res.json({
    success: true,
    data: instrument,
    timestamp: new Date().toISOString()
  });
});

export const getAllInstruments = asyncHandler(async (req: Request, res: Response) => {
  const { type, limit = '100' } = req.query;
  
  const instruments = await prisma.instrument.findMany({
    where: type ? { type: { equals: type as string, mode: 'insensitive' } } : {},
    take: parseInt(limit as string),
    orderBy: { ticker: 'asc' }
  });

  res.json({
    success: true,
    data: instruments,
    count: instruments.length,
    timestamp: new Date().toISOString()
  });
});