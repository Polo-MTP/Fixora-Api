import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { storageService } from '../services/storage.service.ts';
import { BadRequestError } from '../errors/app-error.ts';
import type { FileCategory } from '../types/storage.types.ts';

const VALID_CATEGORIES: FileCategory[] = ['documents', 'photos', 'evidences'];

export class StorageController {
  /**
   * Sube un archivo y devuelve la llave generada (no la URL) junto a su metadata
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        throw new BadRequestError("Debes adjuntar un archivo en el campo 'file'.");
      }

      const rawCategory = (req.body.category as string | undefined)?.toLowerCase() ?? 'documents';

      if (!VALID_CATEGORIES.includes(rawCategory as FileCategory)) {
        throw new BadRequestError(
          `Categoría no válida: '${rawCategory}'. Las categorías permitidas son: ${VALID_CATEGORIES.join(', ')}.`,
        );
      }

      const category = rawCategory as FileCategory;
      const isVerification =
        req.body.is_verification === true ||
        req.body.is_verification === 'true' ||
        category === 'documents';

      const result = await storageService.saveUploadedFile(req.file, category, isVerification);

      res.status(201).json({
        success: true,
        message: 'Archivo subido y almacenado exitosamente.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Genera un enlace firmado con vigencia para acceder a un archivo
   * Restringe documentos de verificación únicamente para el Administrador
   */
  async getSignedUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { file_key, expires_in_minutes, disposition, download_name } = req.body;

      if (!file_key || typeof file_key !== 'string') {
        throw new BadRequestError('Debes proporcionar el campo file_key.');
      }

      const requesterRole = req.user?.role;

      const result = storageService.generateSignedUrl(
        {
          file_key,
          expires_in_minutes: expires_in_minutes ? Number(expires_in_minutes) : 30,
          disposition: disposition === 'attachment' ? 'attachment' : 'inline',
          download_name,
        },
        requesterRole,
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Descarga o previsualiza un archivo mediante enlace firmado validado
   */
  async download(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const fileKey = (req.query.key as string) ?? '';
      const expires = (req.query.expires as string) ?? '';
      const signature = (req.query.signature as string) ?? '';
      const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
      const customName = req.query.name as string | undefined;

      // Validar firma y vigencia
      storageService.verifySignedUrl(fileKey, expires, signature, disposition, req.user?.role);

      const fileInfo = await storageService.getFileForDownload(fileKey);
      const downloadFilename = customName ? path.basename(customName) : fileInfo.filename;

      res.setHeader('Content-Type', fileInfo.mimeType);
      res.setHeader('Content-Length', fileInfo.sizeBytes);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${encodeURIComponent(downloadFilename)}"`,
      );
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

      const fileStream = fs.createReadStream(fileInfo.fullPath);
      fileStream.on('error', (streamError) => {
        next(streamError);
      });
      fileStream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Elimina un archivo del almacenamiento
   */
  async deleteFile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const fileKey = req.body.file_key ?? (req.query.file_key as string);

      if (!fileKey || typeof fileKey !== 'string') {
        throw new BadRequestError('Debes indicar el campo file_key a eliminar.');
      }

      // Si es documento de verificación, solo un administrador puede eliminarlo
      const isVerification = storageService.isVerificationDocument(fileKey);
      if (isVerification && req.user?.role !== 'administrador') {
        throw new BadRequestError(
          'Solo el Administrador puede eliminar documentos de verificación.',
        );
      }

      const deleted = await storageService.deleteFile(fileKey);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: {
            message: 'El archivo no existe o ya fue eliminado.',
            statusCode: 404,
          },
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Archivo eliminado correctamente.',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const storageController = new StorageController();
