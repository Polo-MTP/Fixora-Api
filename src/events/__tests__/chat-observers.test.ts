import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../event-bus.ts';
import { ChatMessageSentEvent, ChatMessagesReadEvent } from '../events/domain-events.ts';
import {
    NotificationObserver,
    type NotificationRecord,
} from '../observers/notification.observer.ts';
import { HistoryObserver } from '../observers/history.observer.ts';
import { RealTimeObserver, type RealTimeMessage } from '../observers/realtime.observer.ts';
import { setupDomainEventObservers } from '../index.ts';

describe('Observadores del chat por solicitud (API-35)', () => {
    let bus: EventBus;
    let persisted: NotificationRecord[];
    let pushed: NotificationRecord[];
    let realTimeMessages: RealTimeMessage[];
    let onlineUsers: Set<string>;

    beforeEach(() => {
        bus = new EventBus();
        persisted = [];
        pushed = [];
        realTimeMessages = [];
        onlineUsers = new Set();

        setupDomainEventObservers(bus, {
            notificationObserver: new NotificationObserver(
                async (record) => {
                    persisted.push(record);
                },
                async (record) => {
                    pushed.push(record);
                },
                async () => [],
                (userId) => onlineUsers.has(userId),
            ),
            historyObserver: new HistoryObserver(async () => { }),
            realtimeObserver: new RealTimeObserver((message) => {
                realTimeMessages.push(message);
            }),
        });
    });

    function sentEvent() {
        return new ChatMessageSentEvent({
            requestId: '501',
            conversationId: '77',
            messageId: '900',
            senderId: '10',
            senderName: 'Ana Pérez',
            recipientUserIds: ['20'],
            preview: 'Ya voy en camino',
            hasAttachments: false,
            message: { id: '900', message: 'Ya voy en camino', client_uuid: 'abc' },
        });
    }

    it('publica el mensaje en la sala del chat y avisa al destinatario en su sala personal', async () => {
        await bus.notify(sentEvent());

        const chat = realTimeMessages.find((m) => m.channel === 'chats:501');
        assert.equal(chat?.event, 'chat_message');
        assert.equal((chat?.data as { id: string }).id, '900');

        const unread = realTimeMessages.find((m) => m.channel === 'users:20');
        assert.equal(unread?.event, 'chat_unread');
        assert.equal((unread?.data as { preview: string }).preview, 'Ya voy en camino');
    });

    it('envía push al destinatario que no tiene la app conectada', async () => {
        await bus.notify(sentEvent());

        assert.equal(pushed.length, 1);
        assert.equal(pushed[0]!.userId, '20');
        assert.equal(pushed[0]!.type, 'chat_message');
        assert.equal(pushed[0]!.title, 'Mensaje de Ana Pérez');
        assert.equal(pushed[0]!.entityType, 'service_request');
        assert.equal(pushed[0]!.entityId, '501');
    });

    it('no envía push si el destinatario tiene la app conectada', async () => {
        onlineUsers.add('20');
        await bus.notify(sentEvent());
        assert.equal(pushed.length, 0);
    });

    it('no guarda un registro en el centro de notificaciones por cada mensaje', async () => {
        await bus.notify(sentEvent());
        assert.equal(persisted.length, 0);
    });

    it('publica la marca de leído solo en la sala del chat', async () => {
        await bus.notify(
            new ChatMessagesReadEvent({
                requestId: '501',
                conversationId: '77',
                readerId: '20',
                messageIds: ['900', '901'],
                readAt: '2026-11-19T18:00:00.000Z',
            }),
        );

        assert.equal(realTimeMessages.length, 1);
        assert.equal(realTimeMessages[0]!.channel, 'chats:501');
        assert.equal(realTimeMessages[0]!.event, 'chat_messages_read');
        assert.equal(pushed.length, 0);
    });
});
