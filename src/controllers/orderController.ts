import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { OrderService } from '../services/orderService';

const prisma = new PrismaClient();
const orderService = new OrderService(prisma);

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const orderData = req.body;
  
  // Validate required fields
  const requiredFields = ['instrumentId', 'userId', 'side', 'type', 'size'];
  for (const field of requiredFields) {
    if (!orderData[field]) {
      throw createError(`${field} is required`, 400);
    }
  }

  // Validate side and type
  const validSides = ['BUY', 'SELL', 'CASH_IN', 'CASH_OUT'];
  const validTypes = ['MARKET', 'LIMIT'];
  
  if (!validSides.includes(orderData.side)) {
    throw createError(`Invalid side. Must be one of: ${validSides.join(', ')}`, 400);
  }
  
  if (!validTypes.includes(orderData.type)) {
    throw createError(`Invalid type. Must be one of: ${validTypes.join(', ')}`, 400);
  }

  // For LIMIT orders, price is required
  if (orderData.type === 'LIMIT' && !orderData.price) {
    throw createError('Price is required for LIMIT orders', 400);
  }

  // Validate size
  if (typeof orderData.size !== 'number' || orderData.size <= 0) {
    throw createError('Size must be a positive number', 400);
  }

  // For LIMIT orders, validate price
  if (orderData.type === 'LIMIT' && (!orderData.price || orderData.price <= 0)) {
    throw createError('Price must be a positive number for LIMIT orders', 400);
  }

  const order = await orderService.createOrder(orderData);
  
  res.status(201).json({
    success: true,
    data: order,
    message: 'Order created successfully',
    timestamp: new Date().toISOString()
  });
});

export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { userId } = req.body;
  
  if (!orderId || isNaN(parseInt(orderId))) {
    throw createError('Valid order ID is required', 400);
  }

  if (!userId) {
    throw createError('User ID is required', 400);
  }

  const order = await orderService.cancelOrder(parseInt(orderId), userId);
  
  res.json({
    success: true,
    data: order,
    message: 'Order cancelled successfully',
    timestamp: new Date().toISOString()
  });
});

export const getUserOrders = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.query;
  const { status, type, side, limit = '50' } = req.query;
  
  if (!userId || typeof userId !== 'string') {
    throw createError('User ID is required', 400);
  }

  const filters: any = {
    userId: parseInt(userId)
  };

  if (status) filters.status = status;
  if (type) filters.type = type;
  if (side) filters.side = side;

  const orders = await prisma.order.findMany({
    where: filters,
    include: {
      instrument: {
        select: {
          id: true,
          ticker: true,
          name: true,
          type: true
        }
      }
    },
    orderBy: { datetime: 'desc' },
    take: parseInt(limit as string)
  });

  res.json({
    success: true,
    data: orders,
    count: orders.length,
    filters,
    timestamp: new Date().toISOString()
  });
});