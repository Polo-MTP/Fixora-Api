import './utils/bigint-serializer.ts';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { ENV } from './config/env.ts';
import { requestLogger } from './middlewares/logger.middleware.ts';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.ts';
import { apiRouter } from './routes/index.ts';

const app: Express = express();

// Middlewares globales
app.use(cors({ origin: ENV.CORS_ORIGIN }));
app.use(express.json());
app.use(requestLogger);

// Ruta base
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Fixora API',
    version: '1.0.0',
    documentation: '/api/docs',
    status: 'online',
  });
});

// Rutas de la API
app.use('/api', apiRouter);

// Manejador de rutas no encontradas (404)
app.use(notFoundHandler);

// Manejador centralizado de errores (500, AppError, etc.)
app.use(errorHandler);

// Iniciar servidor
app.listen(ENV.PORT, () => {
  console.log(`🚀 Fixora API corriendo en http://localhost:${ENV.PORT} [${ENV.NODE_ENV}]`);
});

export default app;
