import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENV } from '../config/env.ts';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/app-error.ts';
import {
  type FileCategory,
  STORAGE_RULES,
  type UploadedFileResult,
  type SignedUrlOptions,
  type SignedUrlResult,
  type VerifiedSignaturePayload,
} from '../types/storage.types.ts';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

export class StorageService {
  private readonly storageRoot: string;
  private readonly signSecret: string;

  constructor() {
    this.storageRoot = path.resolve(process.cwd(), ENV.STORAGE_DIR);
    this.signSecret = ENV.STORAGE_SIGNED_URL_SECRET;
    this.ensureBaseDirectories();
  }

  /**
   * Asegura que existan los directorios base de almacenamiento local (tipo Laravel Storage)
   */
  public ensureBaseDirectories(): void {
    const categories: FileCategory[] = ['documents', 'photos', 'evidences'];

    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
    }

    // Archivo .gitkeep en el directorio raíz para permitir control opcional sin subir archivos
    const gitkeepPath = path.join(this.storageRoot, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) {
      try {
        fs.writeFileSync(gitkeepPath, '');
      } catch {
        // Ignorar si no se puede escribir
      }
    }

    for (const cat of categories) {
      const catDir = path.join(this.storageRoot, cat);
      if (!fs.existsSync(catDir)) {
        fs.mkdirSync(catDir, { recursive: true });
      }
    }

    // Subdirectorio exclusivo para verificación
    const verificationDir = path.join(this.storageRoot, 'documents', 'verification');
    if (!fs.existsSync(verificationDir)) {
      fs.mkdirSync(verificationDir, { recursive: true });
    }
  }

  /**
   * Resuelve y valida de forma estricta que una ruta no salga del directorio de almacenamiento (previene Path Traversal)
   */
  public resolveSafePath(fileKey: string): string {
    if (!fileKey || typeof fileKey !== 'string') {
      throw new BadRequestError('La llave del archivo es obligatoria.');
    }

    // Normalizar separadores
    const normalizedKey = fileKey.replace(/\\/g, '/').replace(/^\/+/, '');

    // Evitar secuencias maliciosas
    if (normalizedKey.includes('..') || normalizedKey.includes(':')) {
      throw new ForbiddenError('Ruta de archivo no permitida (Path Traversal detectado).');
    }

    const resolved = path.resolve(this.storageRoot, normalizedKey);

    // Debe comenzar estrictamente con el directorio raíz de almacenamiento
    if (!resolved.startsWith(this.storageRoot)) {
      throw new ForbiddenError('Acceso denegado: la ruta está fuera del almacenamiento.');
    }

    return resolved;
  }

  /**
   * Determina si un archivo corresponde a un documento de verificación
   */
  public isVerificationDocument(
    fileKey: string,
    category?: string,
    isVerificationFlag?: boolean,
  ): boolean {
    if (isVerificationFlag === true) return true;
    const normalized = fileKey.replace(/\\/g, '/').toLowerCase();

    return (
      normalized.startsWith('documents/verification/') ||
      normalized.includes('/verification/') ||
      (category === 'documents' && isVerificationFlag !== false)
    );
  }

  /**
   * Valida tamaño y tipo MIME de un archivo según la categoría
   */
  public validateFile(file: Express.Multer.File, category: FileCategory): void {
    const rules = STORAGE_RULES[category];

    if (!rules) {
      throw new BadRequestError(`Categoría de almacenamiento no válida: ${category}`);
    }

    // Validar tamaño
    if (file.size > rules.maxSizeBytes) {
      const maxMb = (rules.maxSizeBytes / (1024 * 1024)).toFixed(0);
      throw new BadRequestError(
        `El archivo excede el tamaño máximo permitido para ${rules.label} (${maxMb} MB). Tamaño actual: ${(file.size / (1024 * 1024)).toFixed(2)} MB.`,
      );
    }

    // Validar tipo MIME
    const mimeNormalized = file.mimetype.toLowerCase();
    if (!rules.allowedMimeTypes.includes(mimeNormalized)) {
      throw new BadRequestError(
        `Tipo de archivo no permitido (${file.mimetype}). Tipos válidos para ${rules.label}: ${rules.allowedMimeTypes.join(', ')}`,
      );
    }

    // Validar extensión
    const ext = path.extname(file.originalname).toLowerCase();
    if (!rules.allowedExtensions.includes(ext)) {
      throw new BadRequestError(
        `Extensión de archivo no permitida (${ext}). Extensiones válidas para ${rules.label}: ${rules.allowedExtensions.join(', ')}`,
      );
    }
  }

  /**
   * Genera una llave de archivo única, organizada por fecha y sanitizada
   */
  public generateFileKey(
    category: FileCategory,
    originalName: string,
    isVerification = false,
  ): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const uuid = crypto.randomUUID();

    const ext = path.extname(originalName).toLowerCase();
    const baseName = path.basename(originalName, ext);
    const sanitizedBase = baseName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);

    const filename = `${uuid}-${sanitizedBase}${ext}`;

    if (category === 'documents' && isVerification) {
      return `documents/verification/${year}/${month}/${filename}`;
    }

    return `${category}/${year}/${month}/${filename}`;
  }

  /**
   * Guarda un archivo recibido en memoria en el almacenamiento local
   */
  public async saveUploadedFile(
    file: Express.Multer.File,
    category: FileCategory,
    isVerification = false,
  ): Promise<UploadedFileResult> {
    this.validateFile(file, category);

    // Calcular hash SHA-256 para integridad y detección de duplicados
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // Generar llave de archivo relativa
    const fileKey = this.generateFileKey(category, file.originalname, isVerification);
    const fullPath = this.resolveSafePath(fileKey);

    // Crear subcarpetas según sea necesario
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Escribir archivo al disco
    await fs.promises.writeFile(fullPath, file.buffer);

    return {
      file_key: fileKey,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size_bytes: file.size,
      file_hash: fileHash,
      category,
      is_verification: isVerification,
      uploaded_at: new Date().toISOString(),
    };
  }

  /**
   * Genera un enlace firmado (Signed URL) con vigencia para acceso seguro
   * Restringe documentos de verificación exclusivamente a administradores
   */
  public generateSignedUrl(options: SignedUrlOptions, requesterRole?: string): SignedUrlResult {
    const { file_key, expires_in_minutes = 30, disposition = 'inline', download_name } = options;

    if (!file_key) {
      throw new BadRequestError('Debes indicar la llave del archivo (file_key).');
    }

    const isVerification = this.isVerificationDocument(file_key);

    // REGLA CRÍTICA DEL SPRINT: Documentos de verificación accesibles SOLO para el Administrador
    if (isVerification && requesterRole !== 'administrador') {
      throw new ForbiddenError(
        'Acceso denegado: los documentos de verificación sólo son accesibles para el Administrador.',
      );
    }

    // Validar vigencia máxima (por ejemplo entre 1 y 1440 minutos = 24 horas)
    const validMinutes = Math.min(Math.max(Number(expires_in_minutes) || 30, 1), 1440);
    const expiresTimestamp = Date.now() + validMinutes * 60 * 1000;

    // Generar firma HMAC-SHA256
    const signaturePayload = `${file_key}:${expiresTimestamp}:${disposition}:${isVerification ? 'admin' : 'public'}`;
    const signature = crypto
      .createHmac('sha256', this.signSecret)
      .update(signaturePayload)
      .digest('hex');

    // Construir URL firmada
    const params = new URLSearchParams({
      key: file_key,
      expires: String(expiresTimestamp),
      signature,
      disposition,
    });

    if (download_name) {
      params.set('name', download_name);
    }

    const signedUrl = `${ENV.APP_URL}/api/files/download?${params.toString()}`;

    return {
      file_key,
      signed_url: signedUrl,
      expires_at: new Date(expiresTimestamp).toISOString(),
      expires_in_seconds: validMinutes * 60,
    };
  }

  /**
   * Valida la firma criptográfica y vigencia de un enlace firmado
   */
  public verifySignedUrl(
    fileKey: string,
    expiresStr: string,
    signature: string,
    disposition: 'inline' | 'attachment' = 'inline',
    requesterRole?: string,
  ): VerifiedSignaturePayload {
    if (!fileKey || !expiresStr || !signature) {
      throw new UnauthorizedError('Parámetros de firma incompletos en el enlace.');
    }

    const expires = Number(expiresStr);
    if (!Number.isFinite(expires)) {
      throw new UnauthorizedError('El parámetro de expiración no es válido.');
    }

    // Validar vigencia
    if (Date.now() > expires) {
      throw new UnauthorizedError('El enlace firmado ha expirado. Solicita un nuevo enlace.');
    }

    const isVerification = this.isVerificationDocument(fileKey);

    // Si es un documento de verificación y se cuenta con sesión autenticada, verificar que sea administrador
    if (isVerification && requesterRole && requesterRole !== 'administrador') {
      throw new ForbiddenError(
        'Acceso denegado: los documentos de verificación sólo son accesibles para el Administrador.',
      );
    }

    // Recomputar firma esperada
    const expectedPayload = `${fileKey}:${expires}:${disposition}:${isVerification ? 'admin' : 'public'}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.signSecret)
      .update(expectedPayload)
      .digest('hex');

    // Comparación segura en tiempo constante contra ataques de temporización
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedError('La firma del enlace no es válida o ha sido manipulada.');
    }

    return {
      file_key: fileKey,
      expires,
      disposition,
      isAdminDoc: isVerification,
    };
  }

  /**
   * Obtiene la información física del archivo para descarga o previsualización
   */
  public async getFileForDownload(fileKey: string): Promise<{
    fullPath: string;
    mimeType: string;
    sizeBytes: number;
    filename: string;
  }> {
    const fullPath = this.resolveSafePath(fileKey);

    try {
      const stats = await fs.promises.stat(fullPath);
      if (!stats.isFile()) {
        throw new NotFoundError('El archivo solicitado no existe.');
      }

      const ext = path.extname(fullPath).toLowerCase();
      const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
      const filename = path.basename(fullPath);

      return {
        fullPath,
        mimeType,
        sizeBytes: stats.size,
        filename,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`El archivo con la llave '${fileKey}' no fue encontrado.`);
      }
      throw error;
    }
  }

  /**
   * Elimina un archivo físico del almacenamiento
   */
  public async deleteFile(fileKey: string): Promise<boolean> {
    const fullPath = this.resolveSafePath(fileKey);

    try {
      await fs.promises.unlink(fullPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}

export const storageService = new StorageService();
