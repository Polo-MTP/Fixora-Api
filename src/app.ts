
import './utils/bigint-serializer.ts';
import 'dotenv/config';

import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { ENV } from './config/env.ts';
import { requestLogger } from './middlewares/logger.middleware.ts';
import {
    errorHandler,
    notFoundHandler,
} from './middlewares/error.middleware.ts';

import { apiRouter } from './routes/index.ts';
import authRoutes from './routes/auth.routes.ts';
import testAuthRoutes from './routes/auth.test.routes.ts';

import { swaggerUi, openApiDocument } from './config/swagger.ts';

const app = express();

app.disable('x-powered-by');

// Middlewares globales
app.use(cors({ origin: ENV.CORS_ORIGIN }));
app.use(express.json({ limit: '20kb' }));
app.use(requestLogger);

// Ruta base
app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
        name: 'Fixora API',
        version: '1.0.0',
        documentation: '/api/docs',
        status: 'online',
    });
});

// Estado de la API
app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'Fixora-Api',
    });
});

// Documentación Swagger
app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument),
);

// Rutas generales
app.use('/api', apiRouter);

// Autenticación
app.use('/api/auth', authRoutes);

// Rutas de pruebas, únicamente fuera de producción
if (ENV.NODE_ENV !== 'production') {
    app.use('/api/dev', testAuthRoutes);
}

// Manejadores globales
app.use(notFoundHandler);
app.use(errorHandler);

const port = ENV.PORT;

async function startServer() {
    try {
        app.listen(port, () => {
            console.log(
                `Fixora API corriendo en http://localhost:${port} [${ENV.NODE_ENV}]`,
            );
            console.log(`Documentación: http://localhost:${port}/api/docs`);

            if (ENV.NODE_ENV !== 'production') {
                console.log(
                    `Usuarios de prueba: http://localhost:${port}/api/dev/users`,
                );
            }
        });
    } catch (error) {
        console.error('Error al inicializar Fixora API:', error);
        process.exitCode = 1;
    }
}

startServer();

export default app;
