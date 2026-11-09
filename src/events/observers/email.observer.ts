import type { DomainEvent } from '../interfaces/domain-event.interface.ts';
import type { Observer } from '../interfaces/observer.interface.ts';
import { DOMAIN_EVENTS, type SupplierApplicationResolvedPayload } from '../events/domain-events.ts';
import { sendSupplierVerificationResultEmail } from '../../services/email.service.ts';

export class EmailObserver implements Observer<DomainEvent> {
    public readonly name = 'EmailObserver';

    public async handle(event: DomainEvent): Promise<void> {
        if (event.eventType !== DOMAIN_EVENTS.SUPPLIER_APPLICATION_RESOLVED) return;

        const payload = event.payload as SupplierApplicationResolvedPayload;
        await sendSupplierVerificationResultEmail({
            email: payload.email,
            managerName: payload.managerName,
            businessName: payload.businessName,
            status: payload.state,
            comments: payload.comments ?? undefined,
            missingDocuments: payload.missingDocuments,
        });
    }
}
