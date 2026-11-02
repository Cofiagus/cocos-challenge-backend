import { PrismaClient } from '@prisma/client';

export interface OrderData {
  instrumentId: number;
  userId: number;
  side: 'BUY' | 'SELL' | 'CASH_IN' | 'CASH_OUT';
  type: 'MARKET' | 'LIMIT';
  size: number;
  price?: number;
}

export interface Order extends OrderData {
  id: number;
  status: 'NEW' | 'FILLED' | 'CANCELLED';
  datetime: Date;
}

export class OrderService {
  constructor(private prisma: PrismaClient) {}

  async createOrder(orderData: OrderData): Promise<Order> {
    const { instrumentId, userId, side, type, size, price } = orderData;

    // Start transaction for atomic operations
    const result = await this.prisma.$transaction(async (tx) => {
      // Check if instrument exists
      const instrument = await tx.instrument.findUnique({
        where: { id: instrumentId }
      });

      if (!instrument) {
        throw new Error('Instrument not found');
      }

      // For MARKET orders, execute immediately
      if (type === 'MARKET') {
        return this.executeMarketOrder(tx, orderData);
      }

      // For LIMIT orders, create as NEW
      return tx.order.create({
        data: {
          instrumentId,
          userId,
          size,
          price: price || 0,
          type,
          side,
          status: 'NEW'
        }
      });
    });

    return result;
  }

  async cancelOrder(orderId: number, userId: number): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId }
    });

    if (!order) {
      throw new Error('Order not found or access denied');
    }

    if (order.status !== 'NEW') {
      throw new Error('Only orders in NEW status can be cancelled');
    }

    const cancelledOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' }
    });

    return cancelledOrder;
  }

  private async executeMarketOrder(tx: PrismaClient, orderData: OrderData): Promise<Order> {
    const { instrumentId, userId, side, size } = orderData;

    // For simplicity, we'll just create the order as FILLED
    // In a real system, this would involve matching with existing orders
    // and checking market liquidity
    return tx.order.create({
      data: {
        instrumentId,
        userId,
        size,
        price: 0, // Market price would be determined by matching
        type: 'MARKET',
        side,
        status: 'FILLED'
      }
    });
  }

  async validateOrder(orderData: OrderData): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if instrument exists
    const instrument = await this.prisma.instrument.findUnique({
      where: { id: orderData.instrumentId }
    });

    if (!instrument) {
      errors.push('Instrument not found');
    }

    // Validate side
    const validSides = ['BUY', 'SELL', 'CASH_IN', 'CASH_OUT'];
    if (!validSides.includes(orderData.side)) {
      errors.push(`Invalid side: ${orderData.side}`);
    }

    // Validate type
    const validTypes = ['MARKET', 'LIMIT'];
    if (!validTypes.includes(orderData.type)) {
      errors.push(`Invalid type: ${orderData.type}`);
    }

    // Validate size
    if (orderData.size <= 0) {
      errors.push('Size must be positive');
    }

    // Validate price for LIMIT orders
    if (orderData.type === 'LIMIT' && (!orderData.price || orderData.price <= 0)) {
      errors.push('Price must be positive for LIMIT orders');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}