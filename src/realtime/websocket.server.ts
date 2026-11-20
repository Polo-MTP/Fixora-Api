import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  employees,
  request_dispatches,
  roles,
  sessions,
  service_requests,
  suppliers,
  users,
  branches,
  business_supplier,
} from '../database/schema/tables.ts';
import type { RealTimeMessage } from '../events/observers/realtime.observer.ts';
import { canAccessChat } from '../services/chat.service.ts';

const WS_PATH = '/ws';
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const JWT_ISSUER = 'fixora-api';
const JWT_AUDIENCE = 'fixora-client';

interface AccessTokenPayload {
  sub: string;
  role: string;
  sid: string;
  type: 'access';
  scope?: 'supplier_application';
}

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  role?: string;
  sessionId?: string;
  accessToken?: string;
  authenticated?: boolean;
  isAlive?: boolean;
  rooms: Set<string>;
  authTimer?: NodeJS.Timeout;
  sessionCheckTimer?: NodeJS.Timeout;
}

interface ClientMessage {
  type?: unknown;
  token?: unknown;
  requestId?: unknown;
}

const sockets = new Set<AuthenticatedSocket>();
const rooms = new Map<string, Set<AuthenticatedSocket>>();
let websocketServer: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function joinRoom(socket: AuthenticatedSocket, room: string): void {
  let members = rooms.get(room);
  if (!members) {
    members = new Set();
    rooms.set(room, members);
  }
  members.add(socket);
  socket.rooms.add(room);
}

function leaveRoom(socket: AuthenticatedSocket, room: string): void {
  rooms.get(room)?.delete(socket);
  if (rooms.get(room)?.size === 0) rooms.delete(room);
  socket.rooms.delete(room);
}

function cleanup(socket: AuthenticatedSocket): void {
  if (socket.authTimer) clearTimeout(socket.authTimer);
  if (socket.sessionCheckTimer) clearInterval(socket.sessionCheckTimer);
  for (const room of socket.rooms) leaveRoom(socket, room);
  sockets.delete(socket);
}

async function authenticate(
  token: string,
): Promise<{ userId: string; role: string; sessionId: string }> {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_CONFIGURATION_ERROR');

  const decoded = jwt.verify(token, secret, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
  if (
    typeof decoded === 'string' ||
    decoded.type !== 'access' ||
    typeof decoded.sub !== 'string' ||
    typeof decoded.sid !== 'string' ||
    typeof decoded.role !== 'string' ||
    (decoded.scope !== undefined && decoded.scope !== 'supplier_application')
  )
    throw new Error('INVALID_ACCESS_TOKEN');

  const payload = decoded as unknown as AccessTokenPayload;
  const [session] = await db
    .select({
      userId: users.UniqueID,
      state: users.state,
      roleName: roles.name,
      roleActive: roles.active,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.user_id, users.UniqueID))
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(
      and(
        eq(sessions.id, payload.sid),
        eq(sessions.revoked, false),
        gt(sessions.expires_at, new Date()),
      ),
    )
    .limit(1);

  if (!session || session.userId.toString() !== payload.sub) throw new Error('INVALID_SESSION');
  const state = String(session.state).trim().toLowerCase();
  if (!session.roleActive || !['activo', 'activa'].includes(state))
    throw new Error('ACCOUNT_NOT_ACTIVE');

  return { userId: session.userId.toString(), role: session.roleName, sessionId: payload.sid };
}

async function canJoinRequestRoom(
  userId: string,
  role: string,
  requestId: bigint,
): Promise<boolean> {
  const [request] = await db
    .select({
      id: service_requests.UniqueID,
      clientId: service_requests.client_id,
      employeeId: service_requests.employee_id,
      branchId: service_requests.branch_id,
    })
    .from(service_requests)
    .where(eq(service_requests.UniqueID, requestId))
    .limit(1);
  if (!request) return false;
  const actorId = BigInt(userId);
  if (request.clientId === actorId) return true;

  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === 'empleado' || normalizedRole === 'gerente') {
    const assignments = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(and(eq(employees.user_id, actorId), eq(employees.active, true)));
    const employeeIds = assignments.map((item) => item.id);
    if (request.employeeId && employeeIds.includes(request.employeeId)) return true;
    if (employeeIds.length) {
      const [dispatch] = await db
        .select({ id: request_dispatches.UniqueID })
        .from(request_dispatches)
        .where(
          and(
            eq(request_dispatches.request_id, requestId),
            inArray(request_dispatches.employee_id, employeeIds),
          ),
        )
        .limit(1);
      if (dispatch) return true;
    }
    if (normalizedRole === 'gerente' && assignments.length && request.branchId !== null) {
      const [branchAssignment] = await db
        .select({ id: employees.UniqueID })
        .from(employees)
        .where(
          and(
            eq(employees.user_id, actorId),
            eq(employees.branch_id, request.branchId),
            eq(employees.active, true),
          ),
        )
        .limit(1);
      if (branchAssignment) return true;
    }
  }

  if (normalizedRole === 'proveedor' && request.branchId !== null) {
    const [ownedBranch] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
      .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
      .where(
        and(
          eq(branches.UniqueID, request.branchId),
          eq(suppliers.user_id, actorId),
          eq(suppliers.active, true),
          eq(business_supplier.active, true),
        ),
      )
      .limit(1);
    if (ownedBranch) return true;
  }
  return false;
}

async function handleMessage(socket: AuthenticatedSocket, raw: Buffer): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw.toString('utf8')) as ClientMessage;
  } catch {
    send(socket, {
      type: 'error',
      code: 'INVALID_JSON',
      message: 'El mensaje debe ser JSON válido.',
    });
    return;
  }

  if (!socket.authenticated) {
    if (
      message.type !== 'authenticate' ||
      typeof message.token !== 'string' ||
      !message.token.trim()
    ) {
      send(socket, {
        type: 'error',
        code: 'AUTH_REQUIRED',
        message: 'Envía primero {"type":"authenticate","token":"..."}.',
      });
      socket.close(1008, 'Autenticación requerida');
      return;
    }
    try {
      const user = await authenticate(message.token.trim());
      socket.userId = user.userId;
      socket.role = user.role;
      socket.sessionId = user.sessionId;
      socket.accessToken = message.token.trim();
      socket.authenticated = true;
      if (socket.authTimer) clearTimeout(socket.authTimer);
      socket.sessionCheckTimer = setInterval(() => {
        void authenticate(socket.accessToken!)
          .then((current) => {
            if (current.userId !== socket.userId || current.sessionId !== socket.sessionId) {
              socket.close(1008, 'Sesión inválida');
            }
          })
          .catch(() => socket.close(1008, 'Sesión expirada o revocada'));
      }, 30_000);
      joinRoom(socket, `users:${user.userId}`);
      send(socket, {
        type: 'authenticated',
        user: { id: user.userId, role: user.role },
        rooms: [`users:${user.userId}`],
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'AUTHENTICATION_FAILED';
      send(socket, { type: 'error', code, message: 'No fue posible autenticar la conexión.' });
      socket.close(1008, 'Token o sesión inválidos');
    }
    return;
  }

  // Revalidar JWT y sesión en cada mensaje para respetar revocaciones y expiraciones.
  try {
    const currentUser = await authenticate(socket.accessToken!);
    if (currentUser.userId !== socket.userId || currentUser.sessionId !== socket.sessionId) {
      throw new Error('INVALID_SESSION');
    }
  } catch {
    send(socket, { type: 'error', code: 'INVALID_SESSION', message: 'La sesión ya no es válida.' });
    socket.close(1008, 'Sesión inválida');
    return;
  }

  if (message.type === 'subscribe_request') {
    if (typeof message.requestId !== 'string' || !/^[1-9]\d{0,17}$/.test(message.requestId)) {
      send(socket, {
        type: 'error',
        code: 'INVALID_REQUEST_ID',
        message: 'requestId no es válido.',
      });
      return;
    }
    const requestId = BigInt(message.requestId);
    const allowed = await canJoinRequestRoom(socket.userId!, socket.role!, requestId);
    if (!allowed) {
      send(socket, {
        type: 'error',
        code: 'FORBIDDEN_ROOM',
        message: 'No tienes acceso a esta solicitud.',
      });
      return;
    }
    const room = `requests:${requestId}`;
    joinRoom(socket, room);
    send(socket, { type: 'subscribed', room });
    return;
  }

  if (message.type === 'unsubscribe_request') {
    if (typeof message.requestId !== 'string' || !/^[1-9]\d{0,17}$/.test(message.requestId)) {
      send(socket, {
        type: 'error',
        code: 'INVALID_REQUEST_ID',
        message: 'requestId no es válido.',
      });
      return;
    }
    const room = `requests:${message.requestId}`;
    leaveRoom(socket, room);
    send(socket, { type: 'unsubscribed', room });
    return;
  }

  // Chat por solicitud (API-35). Sala distinta de requests:<id>: esa admite a técnicos que solo
  // recibieron el aviso, y el chat debe ser únicamente de quien participa en la solicitud.
  if (message.type === 'subscribe_chat') {
    if (typeof message.requestId !== 'string' || !/^[1-9]\d{0,17}$/.test(message.requestId)) {
      send(socket, {
        type: 'error',
        code: 'INVALID_REQUEST_ID',
        message: 'requestId no es válido.',
      });
      return;
    }
    const requestId = BigInt(message.requestId);
    const allowed = await canAccessChat(socket.userId!, socket.role!, requestId);
    if (!allowed) {
      send(socket, {
        type: 'error',
        code: 'FORBIDDEN_ROOM',
        message: 'No tienes acceso al chat de esta solicitud.',
      });
      return;
    }
    const room = `chats:${requestId}`;
    joinRoom(socket, room);
    send(socket, { type: 'subscribed', room });
    return;
  }

  if (message.type === 'unsubscribe_chat') {
    if (typeof message.requestId !== 'string' || !/^[1-9]\d{0,17}$/.test(message.requestId)) {
      send(socket, {
        type: 'error',
        code: 'INVALID_REQUEST_ID',
        message: 'requestId no es válido.',
      });
      return;
    }
    const room = `chats:${message.requestId}`;
    leaveRoom(socket, room);
    send(socket, { type: 'unsubscribed', room });
    return;
  }

  if (message.type === 'ping') {
    send(socket, { type: 'pong', timestamp: new Date().toISOString() });
    return;
  }
  send(socket, {
    type: 'error',
    code: 'UNKNOWN_MESSAGE',
    message: 'Tipo de mensaje no reconocido.',
  });
}

export function attachWebSocketServer(server: Server): WebSocketServer {
  if (websocketServer) return websocketServer;
  websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    websocketServer!.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer!.emit('connection', websocket, request);
    });
  });

  // Sin latido del servidor, un teléfono que pasa a segundo plano deja un socket "abierto" hasta
  // que el TCP expira. Eso haría creer que la app sigue conectada y no se enviaría el push.
  heartbeatTimer = setInterval(() => {
    for (const socket of sockets) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  websocketServer.on('connection', (websocket) => {
    const socket = websocket as AuthenticatedSocket;
    socket.rooms = new Set();
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    sockets.add(socket);
    socket.authTimer = setTimeout(() => {
      if (!socket.authenticated) socket.close(1008, 'Tiempo de autenticación agotado');
    }, AUTH_TIMEOUT_MS);
    socket.on('message', (data) => {
      const raw = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      void handleMessage(socket, raw).catch(() => {
        send(socket, {
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: 'No fue posible procesar el mensaje.',
        });
      });
    });
    socket.on('close', () => cleanup(socket));
    socket.on('error', () => cleanup(socket));
  });
  return websocketServer;
}

export function publishRealtimeMessage(message: RealTimeMessage): void {
  const members = rooms.get(message.channel);
  if (!members?.size) return;
  const payload = JSON.stringify({
    type: 'event',
    event: message.event,
    channel: message.channel,
    data: message.data,
    timestamp: message.timestamp.toISOString(),
  });
  for (const socket of members) {
    if (socket.readyState === WebSocket.OPEN && socket.authenticated) socket.send(payload);
  }
}

/** Indica si el usuario tiene al menos un socket autenticado y abierto (app en primer plano). */
export function hasActiveConnection(userId: string): boolean {
  const members = rooms.get(`users:${userId}`);
  if (!members) return false;
  for (const socket of members) {
    if (socket.authenticated && socket.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function getWebSocketStats() {
  return {
    connections: sockets.size,
    authenticatedConnections: [...sockets].filter((socket) => socket.authenticated).length,
    rooms: rooms.size,
  };
}

export async function closeWebSocketServer(): Promise<void> {
  if (!websocketServer) return;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  for (const socket of sockets) socket.close(1001, 'Servidor apagándose');
  await new Promise<void>((resolve) => websocketServer!.close(() => resolve()));
  websocketServer = null;
  rooms.clear();
  sockets.clear();
}
