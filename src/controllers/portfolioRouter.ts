import { Router } from 'express';
import { getUserPortfolio, getUserPortfolioWithDetails } from './portfolioController';

export const portfolioRouter = Router();

portfolioRouter.get('/', getUserPortfolio);
portfolioRouter.get('/details', getUserPortfolioWithDetails);