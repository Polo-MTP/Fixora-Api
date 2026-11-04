
import {
    and,
    asc,
    desc,
    eq,
    ne
} from 'drizzle-orm';

import { db } from '../config/database.ts';

import {
    users,
    roles,
    sessions,
    personal_data,
    addresses,
    address_user
} from '../database/schema/tables.ts';

import bcrypt from 'bcryptjs';

// ============================================================
// ERRORES DEL MÓDULO
// ============================================================

export class AccountError extends Error {
    public statusCode: number;
    public code: string;

    constructor(statusCode: number, code: string, message: string) {
        super(message);

        this.name = 'AccountError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

// ============================================================
// TIPOS
// ============================================================

export interface UpdatePersonalDataInput {
    name?: string;
    lastname_p?: string;
    lastname_m?: string | null;
    birth_date?: string | null;
    phone?: string | null;
}

export interface ChangePasswordInput {
    currentPassword: string;
    newPassword: string;
}

export interface CreateAddressInput {
    reference?: string | null;
    street: string;
    num_ext: string;
    num_int?: string | null;
    colony: string;
    municipality: string;
    state: string;
    postal_code: string;
    country?: string;
    latitude?: number | string | null;
    longitude?: number | string | null;
    alias?: string | null;
    is_main?: boolean;
}

export interface UpdateAddressInput {
    reference?: string | null;
    street?: string;
    num_ext?: string;
    num_int?: string | null;
    colony?: string;
    municipality?: string;
    state?: string;
    postal_code?: string;
    country?: string;
    latitude?: number | string | null;
    longitude?: number | string | null;
    alias?: string | null;
}

// ============================================================
// VALIDACIONES GENERALES
// ============================================================

function validateText(
    value: unknown,
    field: string,
    maxLength: number,
    required = true
): string | null {
    if (value === null || value === undefined) {
        if (required) {
            throw new AccountError(
                400,
                'ACCOUNT_INVALID_INPUT',
                `${field} es obligatorio.`
            );
        }

        return null;
    }

    if (typeof value !== 'string') {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_INPUT',
            `${field} debe ser un texto.`
        );
    }

    const normalized = value.trim();

    if (!normalized && required) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_INPUT',
            `${field} es obligatorio.`
        );
    }

    if (normalized.length > maxLength) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_INPUT',
            `${field} no puede superar ${maxLength} caracteres.`
        );
    }

    return normalized || null;
}

function validateBirthDate(value: unknown): string | null {
    if (value === null || value === '') {
        return null;
    }

    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_BIRTH_DATE',
            'La fecha de nacimiento debe tener formato YYYY-MM-DD.'
        );
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getTime() > Date.now()
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_BIRTH_DATE',
            'La fecha de nacimiento no es válida.'
        );
    }

    return value;
}

function validateCoordinate(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number
): string | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const numberValue = Number(value);

    if (
        !Number.isFinite(numberValue) ||
        numberValue < minimum ||
        numberValue > maximum
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_COORDINATE',
            `${field} debe estar entre ${minimum} y ${maximum}.`
        );
    }

    return numberValue.toString();
}

function validateAddressId(id: bigint): void {
    if (id <= 0n) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_ADDRESS_ID',
            'El identificador de dirección no es válido.'
        );
    }
}

// ============================================================
// SERIALIZADORES
// ============================================================

function serializeAddress(
    link: typeof address_user.$inferSelect,
    address: typeof addresses.$inferSelect
) {
    return {
        id: address.UniqueID.toString(),
        alias: link.alias,
        is_main: link.is_main,
        reference: address.reference,
        street: address.street,
        num_ext: address.num_ext,
        num_int: address.num_int,
        colony: address.colony,
        municipality: address.municipality,
        state: address.state,
        postal_code: address.postal_code,
        country: address.country,
        latitude: address.latitude,
        longitude: address.longitude
    };
}

// ============================================================
// 1. CONSULTAR MI CUENTA
// ============================================================

export async function getMyAccount(userId: bigint) {
    const [user] = await db
        .select({
            id: users.UniqueID,
            email: users.email,
            state: users.state,
            role: roles.name
        })
        .from(users)
        .leftJoin(
            roles,
            eq(users.role_id, roles.UniqueID)
        )
        .where(eq(users.UniqueID, userId))
        .limit(1);

    if (!user) {
        throw new AccountError(
            404,
            'ACCOUNT_NOT_FOUND',
            'Cuenta no encontrada.'
        );
    }

    const [personalData] = await db
        .select({
            name: personal_data.name,
            lastname_p: personal_data.lastname_p,
            lastname_m: personal_data.lastname_m,
            birth_date: personal_data.birth_date,
            phone: personal_data.phone
        })
        .from(personal_data)
        .where(eq(personal_data.user_id, userId))
        .orderBy(asc(personal_data.UniqueID))
        .limit(1);

    return {
        user: {
            id: user.id.toString(),
            email: user.email,
            role: user.role,
            state: user.state
        },
        personal_data: personalData ?? null
    };
}

// ============================================================
// 2. ACTUALIZAR DATOS PERSONALES
// ============================================================

export async function updateMyAccount(
    userId: bigint,
    input: UpdatePersonalDataInput
) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length === 0
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_INPUT',
            'Debes proporcionar datos para actualizar.'
        );
    }

    const allowedFields = [
        'name',
        'lastname_p',
        'lastname_m',
        'birth_date',
        'phone'
    ];

    for (const field of Object.keys(input)) {
        if (!allowedFields.includes(field)) {
            throw new AccountError(
                400,
                'ACCOUNT_FIELD_NOT_ALLOWED',
                `El campo ${field} no está permitido.`
            );
        }
    }

    const [existing] = await db
        .select()
        .from(personal_data)
        .where(eq(personal_data.user_id, userId))
        .orderBy(asc(personal_data.UniqueID))
        .limit(1);

    const values: {
        name: string;
        lastname_p: string;
        lastname_m: string | null;
        birth_date: string | null;
        phone: string | null;
    } = {
        name: existing?.name ?? '',
        lastname_p: existing?.lastname_p ?? '',
        lastname_m: existing?.lastname_m ?? null,
        birth_date: existing?.birth_date ?? null,
        phone: existing?.phone ?? null
    };

    if (input.name !== undefined) {
        values.name = validateText(
            input.name,
            'El nombre',
            100
        )!;
    }

    if (input.lastname_p !== undefined) {
        values.lastname_p = validateText(
            input.lastname_p,
            'El apellido paterno',
            100
        )!;
    }

    if (input.lastname_m !== undefined) {
        values.lastname_m = validateText(
            input.lastname_m,
            'El apellido materno',
            100,
            false
        );
    }

    if (input.birth_date !== undefined) {
        values.birth_date = validateBirthDate(input.birth_date);
    }

    if (input.phone !== undefined) {
        values.phone = validateText(
            input.phone,
            'El teléfono',
            30,
            false
        );
    }

    if (!values.name || !values.lastname_p) {
        throw new AccountError(
            400,
            'ACCOUNT_REQUIRED_PERSONAL_DATA',
            'Debes proporcionar nombre y apellido paterno.'
        );
    }

    if (existing) {
        const [updated] = await db
            .update(personal_data)
            .set(values)
            .where(
                eq(personal_data.UniqueID, existing.UniqueID)
            )
            .returning();

        return {
            name: updated.name,
            lastname_p: updated.lastname_p,
            lastname_m: updated.lastname_m,
            birth_date: updated.birth_date,
            phone: updated.phone
        };
    }

    const [created] = await db
        .insert(personal_data)
        .values({
            user_id: userId,
            ...values
        })
        .returning();

    return {
        name: created.name,
        lastname_p: created.lastname_p,
        lastname_m: created.lastname_m,
        birth_date: created.birth_date,
        phone: created.phone
    };
}

// ============================================================
// 3. CAMBIAR CONTRASEÑA
// ============================================================

export async function changeMyPassword(
    userId: bigint,
    currentSessionId: string,
    input: ChangePasswordInput
) {
    if (
        !input ||
        typeof input.currentPassword !== 'string' ||
        typeof input.newPassword !== 'string'
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_PASSWORD_INPUT',
            'Debes proporcionar la contraseña actual y la nueva.'
        );
    }

    if (
        input.newPassword.length < 8 ||
        Buffer.byteLength(input.newPassword, 'utf8') > 72
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_NEW_PASSWORD',
            'La nueva contraseña debe tener al menos 8 caracteres y no superar 72 bytes.'
        );
    }

    const [user] = await db
        .select({
            passwordHash: users.password_hash
        })
        .from(users)
        .where(eq(users.UniqueID, userId))
        .limit(1);

    if (!user) {
        throw new AccountError(
            404,
            'ACCOUNT_NOT_FOUND',
            'Cuenta no encontrada.'
        );
    }

    const passwordMatches = await bcrypt.compare(
        input.currentPassword,
        user.passwordHash
    );

    if (!passwordMatches) {
        throw new AccountError(
            400,
            'ACCOUNT_INCORRECT_CURRENT_PASSWORD',
            'La contraseña actual es incorrecta.'
        );
    }

    const samePassword = await bcrypt.compare(
        input.newPassword,
        user.passwordHash
    );

    if (samePassword) {
        throw new AccountError(
            400,
            'ACCOUNT_SAME_PASSWORD',
            'La nueva contraseña debe ser diferente a la actual.'
        );
    }

    // IMPORTANTE:
    // Este valor debe coincidir con el factor de trabajo
    // utilizado en el registro y login actuales de Fixora.

    const newPasswordHash = await bcrypt.hash(
        input.newPassword,
        12
    );

    await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
                password_hash: newPasswordHash
            })
            .where(eq(users.UniqueID, userId));

        // Revocar las demás sesiones.
        // La sesión actual se conserva.

        await tx
            .update(sessions)
            .set({
                revoked: true
            })
            .where(
                and(
                    eq(sessions.user_id, userId),
                    eq(sessions.revoked, false),
                    ne(sessions.id, currentSessionId)
                )
            );
    });

    return {
        passwordChanged: true,
        otherSessionsRevoked: true
    };
}

// ============================================================
// 4. CONSULTAR MIS DIRECCIONES
// ============================================================

export async function getMyAddresses(userId: bigint) {
    const result = await db
        .select({
            link: address_user,
            address: addresses
        })
        .from(address_user)
        .innerJoin(
            addresses,
            eq(address_user.address_id, addresses.UniqueID)
        )
        .where(
            and(
                eq(address_user.user_id, userId),
                eq(address_user.active, true),
                eq(addresses.active, true)
            )
        )
        .orderBy(
            desc(address_user.is_main),
            asc(address_user.UniqueID)
        );

    return result.map(({ link, address }) =>
        serializeAddress(link, address)
    );
}

// ============================================================
// 5. CONSULTAR UNA DIRECCIÓN
// ============================================================

export async function getMyAddress(
    userId: bigint,
    addressId: bigint
) {
    validateAddressId(addressId);

    const [result] = await db
        .select({
            link: address_user,
            address: addresses
        })
        .from(address_user)
        .innerJoin(
            addresses,
            eq(address_user.address_id, addresses.UniqueID)
        )
        .where(
            and(
                eq(address_user.user_id, userId),
                eq(address_user.address_id, addressId),
                eq(address_user.active, true),
                eq(addresses.active, true)
            )
        )
        .limit(1);

    if (!result) {
        throw new AccountError(
            404,
            'ACCOUNT_ADDRESS_NOT_FOUND',
            'Dirección no encontrada.'
        );
    }

    return serializeAddress(
        result.link,
        result.address
    );
}

// ============================================================
// 6. CREAR DIRECCIÓN
// ============================================================

export async function createMyAddress(
    userId: bigint,
    input: CreateAddressInput
) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_ADDRESS_INPUT',
            'Los datos de la dirección no son válidos.'
        );
    }

    const reference = validateText(
        input.reference,
        'La referencia',
        255,
        false
    );

    const street = validateText(
        input.street,
        'La calle',
        255
    )!;

    const num_ext = validateText(
        input.num_ext,
        'El número exterior',
        50
    )!;

    const num_int = validateText(
        input.num_int,
        'El número interior',
        50,
        false
    );

    const colony = validateText(
        input.colony,
        'La colonia',
        150
    )!;

    const municipality = validateText(
        input.municipality,
        'El municipio',
        150
    )!;

    const state = validateText(
        input.state,
        'El estado',
        150
    )!;

    const postal_code = validateText(
        input.postal_code,
        'El código postal',
        20
    )!;

    const country = input.country === undefined
        ? 'México'
        : validateText(input.country, 'El país', 100)!;

    const alias = validateText(
        input.alias,
        'El alias',
        100,
        false
    );

    const latitude = validateCoordinate(
        input.latitude,
        'La latitud',
        -90,
        90
    );

    const longitude = validateCoordinate(
        input.longitude,
        'La longitud',
        -180,
        180
    );

    if (
        input.is_main !== undefined &&
        typeof input.is_main !== 'boolean'
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_ADDRESS_INPUT',
            'is_main debe ser un valor booleano.'
        );
    }

    return db.transaction(async (tx) => {
        const activeAddresses = await tx
            .select({
                id: address_user.UniqueID
            })
            .from(address_user)
            .where(
                and(
                    eq(address_user.user_id, userId),
                    eq(address_user.active, true)
                )
            );

        // La primera dirección siempre será la principal.

        const isMain =
            input.is_main === true ||
            activeAddresses.length === 0;

        if (isMain) {
            await tx
                .update(address_user)
                .set({
                    is_main: false
                })
                .where(
                    and(
                        eq(address_user.user_id, userId),
                        eq(address_user.active, true)
                    )
                );
        }

        const [createdAddress] = await tx
            .insert(addresses)
            .values({
                reference,
                street,
                num_ext,
                num_int,
                colony,
                municipality,
                state,
                postal_code,
                country,
                latitude,
                longitude,
                active: true
            })
            .returning();

        const [createdLink] = await tx
            .insert(address_user)
            .values({
                user_id: userId,
                address_id: createdAddress.UniqueID,
                alias,
                is_main: isMain,
                active: true
            })
            .returning();

        return serializeAddress(
            createdLink,
            createdAddress
        );
    });
}

// ============================================================
// 7. ACTUALIZAR DIRECCIÓN
// ============================================================

export async function updateMyAddress(
    userId: bigint,
    addressId: bigint,
    input: UpdateAddressInput
) {
    validateAddressId(addressId);

    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length === 0
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_ADDRESS_INPUT',
            'Debes proporcionar datos para actualizar.'
        );
    }

    const allowedFields = [
        'reference',
        'street',
        'num_ext',
        'num_int',
        'colony',
        'municipality',
        'state',
        'postal_code',
        'country',
        'latitude',
        'longitude',
        'alias'
    ];

    for (const field of Object.keys(input)) {
        if (!allowedFields.includes(field)) {
            throw new AccountError(
                400,
                'ACCOUNT_FIELD_NOT_ALLOWED',
                `El campo ${field} no está permitido.`
            );
        }
    }

    return db.transaction(async (tx) => {
        const [existing] = await tx
            .select({
                link: address_user,
                address: addresses
            })
            .from(address_user)
            .innerJoin(
                addresses,
                eq(address_user.address_id, addresses.UniqueID)
            )
            .where(
                and(
                    eq(address_user.user_id, userId),
                    eq(address_user.address_id, addressId),
                    eq(address_user.active, true),
                    eq(addresses.active, true)
                )
            )
            .limit(1);

        if (!existing) {
            throw new AccountError(
                404,
                'ACCOUNT_ADDRESS_NOT_FOUND',
                'Dirección no encontrada.'
            );
        }

        const alias = input.alias !== undefined
            ? validateText(input.alias, 'El alias', 100, false)
            : existing.link.alias;

        const addressFields = [
            'reference',
            'street',
            'num_ext',
            'num_int',
            'colony',
            'municipality',
            'state',
            'postal_code',
            'country',
            'latitude',
            'longitude'
        ];

        const hasAddressChanges = addressFields.some(
            (field) => Object.prototype.hasOwnProperty.call(input, field)
        );

        let finalAddress = existing.address;

        if (hasAddressChanges) {
            // Creamos una nueva fila y cambiamos la asociación.
            // Así no modificamos direcciones históricas de servicios
            // ni direcciones que puedan estar compartidas con sucursales.

            const newValues = {
                reference: input.reference !== undefined
                    ? validateText(input.reference, 'La referencia', 255, false)
                    : existing.address.reference,

                street: input.street !== undefined
                    ? validateText(input.street, 'La calle', 255)!
                    : existing.address.street,

                num_ext: input.num_ext !== undefined
                    ? validateText(input.num_ext, 'El número exterior', 50)!
                    : existing.address.num_ext,

                num_int: input.num_int !== undefined
                    ? validateText(input.num_int, 'El número interior', 50, false)
                    : existing.address.num_int,

                colony: input.colony !== undefined
                    ? validateText(input.colony, 'La colonia', 150)!
                    : existing.address.colony,

                municipality: input.municipality !== undefined
                    ? validateText(input.municipality, 'El municipio', 150)!
                    : existing.address.municipality,

                state: input.state !== undefined
                    ? validateText(input.state, 'El estado', 150)!
                    : existing.address.state,

                postal_code: input.postal_code !== undefined
                    ? validateText(input.postal_code, 'El código postal', 20)!
                    : existing.address.postal_code,

                country: input.country !== undefined
                    ? validateText(input.country, 'El país', 100)!
                    : existing.address.country,

                latitude: input.latitude !== undefined
                    ? validateCoordinate(input.latitude, 'La latitud', -90, 90)
                    : existing.address.latitude,

                longitude: input.longitude !== undefined
                    ? validateCoordinate(input.longitude, 'La longitud', -180, 180)
                    : existing.address.longitude,

                active: true
            };

            const [newAddress] = await tx
                .insert(addresses)
                .values(newValues)
                .returning();

            await tx
                .update(address_user)
                .set({
                    address_id: newAddress.UniqueID,
                    alias
                })
                .where(
                    eq(
                        address_user.UniqueID,
                        existing.link.UniqueID
                    )
                );

            finalAddress = newAddress;
        } else {
            await tx
                .update(address_user)
                .set({ alias })
                .where(
                    eq(
                        address_user.UniqueID,
                        existing.link.UniqueID
                    )
                );
        }

        return {
            id: finalAddress.UniqueID.toString(),
            alias,
            is_main: existing.link.is_main,
            reference: finalAddress.reference,
            street: finalAddress.street,
            num_ext: finalAddress.num_ext,
            num_int: finalAddress.num_int,
            colony: finalAddress.colony,
            municipality: finalAddress.municipality,
            state: finalAddress.state,
            postal_code: finalAddress.postal_code,
            country: finalAddress.country,
            latitude: finalAddress.latitude,
            longitude: finalAddress.longitude
        };
    });
}

// ============================================================
// 8. ESTABLECER DIRECCIÓN PRINCIPAL
// ============================================================

export async function setMainAddress(
    userId: bigint,
    addressId: bigint
) {
    validateAddressId(addressId);

    return db.transaction(async (tx) => {
        const [existing] = await tx
            .select({
                linkId: address_user.UniqueID,
                addressId: addresses.UniqueID
            })
            .from(address_user)
            .innerJoin(
                addresses,
                eq(address_user.address_id, addresses.UniqueID)
            )
            .where(
                and(
                    eq(address_user.user_id, userId),
                    eq(address_user.address_id, addressId),
                    eq(address_user.active, true),
                    eq(addresses.active, true)
                )
            )
            .limit(1);

        if (!existing) {
            throw new AccountError(
                404,
                'ACCOUNT_ADDRESS_NOT_FOUND',
                'La dirección no existe o no pertenece a tu cuenta.'
            );
        }

        await tx
            .update(address_user)
            .set({
                is_main: false
            })
            .where(
                and(
                    eq(address_user.user_id, userId),
                    eq(address_user.active, true)
                )
            );

        const [updated] = await tx
            .update(address_user)
            .set({
                is_main: true
            })
            .where(eq(address_user.UniqueID, existing.linkId))
            .returning();

        return {
            address_id: updated.address_id.toString(),
            is_main: updated.is_main
        };
    });
}

// ============================================================
// 9. DESACTIVAR DIRECCIÓN
// ============================================================

export async function deactivateMyAddress(
    userId: bigint,
    addressId: bigint
) {
    validateAddressId(addressId);

    return db.transaction(async (tx) => {
        const [existing] = await tx
            .select()
            .from(address_user)
            .where(
                and(
                    eq(address_user.user_id, userId),
                    eq(address_user.address_id, addressId),
                    eq(address_user.active, true)
                )
            )
            .limit(1);

        if (!existing) {
            throw new AccountError(
                404,
                'ACCOUNT_ADDRESS_NOT_FOUND',
                'Dirección no encontrada.'
            );
        }

        await tx
            .update(address_user)
            .set({
                active: false,
                is_main: false
            })
            .where(
                eq(address_user.UniqueID, existing.UniqueID)
            );

        // Si se eliminó la principal, asignar la primera
        // dirección activa restante como principal.

        if (existing.is_main) {
            const [nextAddress] = await tx
                .select({
                    id: address_user.UniqueID
                })
                .from(address_user)
                .where(
                    and(
                        eq(address_user.user_id, userId),
                        eq(address_user.active, true)
                    )
                )
                .orderBy(asc(address_user.UniqueID))
                .limit(1);

            if (nextAddress) {
                await tx
                    .update(address_user)
                    .set({
                        is_main: true
                    })
                    .where(
                        eq(address_user.UniqueID, nextAddress.id)
                    );
            }
        }

        return {
            address_id: addressId.toString(),
            active: false,
            was_main: existing.is_main
        };
    });
}
