import prisma from '../db/prisma';
import { Profile, CreateProfileParams } from '../types';
import { Prisma } from '@prisma/client';

export const profileService = {
    /**
     * Find a profile by any of the keys.
     * Tries all provided keys and returns the best match (or first found).
     */
    async findProfile(keys: { email?: string; linkedin_slug?: string; linkedin_url?: string; phone_e164?: string }): Promise<{ profile: any | null; resolvedBy: string | null }> {
        const { email, linkedin_slug, linkedin_url, phone_e164 } = keys;

        let foundProfile: any | null = null;
        let resolvedBy: string | null = null;

        // Check for email match first (highest priority)
        if (email) {
            const profile = await prisma.profile.findUnique({ where: { email } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'email';
            }
        }

        // Check for linkedin_url match (newly added column)
        if (!foundProfile && linkedin_url) {
            const profile = await prisma.profile.findUnique({ where: { linkedin_url } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'linkedin_url';
            }
        }

        // Check for linkedin_slug
        if (!foundProfile && linkedin_slug) {
            const profile = await prisma.profile.findUnique({ where: { linkedin_slug } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'linkedin_slug';
            }
        }

        // If no profile found yet, check for phone_e164
        if (!foundProfile && phone_e164) {
            const profile = await prisma.profile.findUnique({ where: { phone_e164 } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'phone_e164';
            }
        }

        return { profile: foundProfile, resolvedBy: resolvedBy };
    },

    /**
     * Safe merge of data JSON
     */
    mergeData(oldData: any, newData: any): any {
        return {
            ...(oldData as object),
            ...newData,
        };
    },

    /**
     * Create a new profile
     */
    async createProfile(params: CreateProfileParams): Promise<any> {
        return await prisma.profile.create({
            data: {
                email: params.email,
                linkedin_slug: params.linkedin_slug,
                linkedin_url: params.linkedin_url,
                phone_e164: params.phone_e164,
                data: params.data ?? {},
            }
        });
    },

    /**
     * Update an existing profile
     */
    async updateProfile(id: string, updates: Partial<Profile>): Promise<any> {
        const { created_at, updated_at, id: _id, ...validUpdates } = updates as any;

        return await prisma.profile.update({
            where: { id },
            data: validUpdates
        });
    },

    /**
     * Cache a contact as a profile from a side-channel (a HubSpot push, a DNC
     * check, etc.) so a later GET /profiles can return it with whatever data we
     * had. Identity keys must already be normalized.
     *
     * Resilient by design — this is best-effort enrichment that must NEVER fail
     * the caller's primary action:
     *  - Resolves ALL profiles owning any provided key (one OR query) and merges
     *    the data into every one of them, so the record stays reachable by any
     *    key even when identity is split across rows by the unique constraints
     *    (no data loss).
     *  - Fills a missing identity column on the primary row only when no other
     *    matched row already owns that value, so it never collides on a unique
     *    constraint owned by a different profile.
     *  - Catches unique-constraint races and DB errors, logs, and degrades to a
     *    data-only merge (or a no-op) rather than throwing.
     */
    async recordProfile(
        identity: { email?: string | null; phone_e164?: string | null; linkedin_url?: string | null; linkedin_slug?: string | null },
        data: Record<string, unknown>
    ): Promise<{ profile_id: string | null; created: boolean }> {
        const keys = {
            email: identity.email || undefined,
            phone_e164: identity.phone_e164 || undefined,
            linkedin_url: identity.linkedin_url || undefined,
            linkedin_slug: identity.linkedin_slug || undefined,
        };

        const or: Prisma.ProfileWhereInput[] = [];
        if (keys.email) or.push({ email: keys.email });
        if (keys.phone_e164) or.push({ phone_e164: keys.phone_e164 });
        if (keys.linkedin_url) or.push({ linkedin_url: keys.linkedin_url });
        if (keys.linkedin_slug) or.push({ linkedin_slug: keys.linkedin_slug });

        // A profile needs at least one identity key; nothing to cache otherwise.
        if (or.length === 0) return { profile_id: null, created: false };

        const mergeInto = async (id: string, existing: any): Promise<void> => {
            try {
                await this.updateProfile(id, { data: this.mergeData(existing, data) } as any);
            } catch (err: any) {
                console.error(`[recordProfile] data merge failed for ${id}:`, err?.message || err);
            }
        };

        try {
            const matches = await prisma.profile.findMany({ where: { OR: or } });

            if (matches.length === 0) {
                try {
                    const created = await this.createProfile({ ...keys, data: data as Prisma.InputJsonValue });
                    return { profile_id: created.id, created: true };
                } catch (err: any) {
                    // Lost a create race: another writer claimed one of these keys.
                    console.error("[recordProfile] create race, merging into existing:", err?.message || err);
                    const again = await prisma.profile.findMany({ where: { OR: or } });
                    for (const p of again) await mergeInto(p.id, p.data);
                    return { profile_id: again[0]?.id ?? null, created: false };
                }
            }

            // Which key values are already owned by SOME matched row — used to
            // avoid filling the primary with a value owned by a different row.
            const owned = new Set<string>();
            for (const p of matches) {
                if (p.email) owned.add(`email:${p.email}`);
                if (p.phone_e164) owned.add(`phone:${p.phone_e164}`);
                if (p.linkedin_slug) owned.add(`lslug:${p.linkedin_slug}`);
                if (p.linkedin_url) owned.add(`lurl:${p.linkedin_url}`);
            }

            const primary = matches.find((p) => keys.email && p.email === keys.email) ?? matches[0];

            // Merge the data into every matched row so it is reachable by any key.
            for (const p of matches) {
                const updates: any = { data: this.mergeData(p.data, data) };
                if (p.id === primary.id) {
                    if (keys.email && !p.email && !owned.has(`email:${keys.email}`)) updates.email = keys.email;
                    if (keys.phone_e164 && !p.phone_e164 && !owned.has(`phone:${keys.phone_e164}`)) updates.phone_e164 = keys.phone_e164;
                    if (keys.linkedin_slug && !p.linkedin_slug && !owned.has(`lslug:${keys.linkedin_slug}`)) updates.linkedin_slug = keys.linkedin_slug;
                    if (keys.linkedin_url && !p.linkedin_url && !owned.has(`lurl:${keys.linkedin_url}`)) updates.linkedin_url = keys.linkedin_url;
                }
                try {
                    await this.updateProfile(p.id, updates);
                } catch (err: any) {
                    console.error(`[recordProfile] key-fill collision on ${p.id}, retrying data-only:`, err?.message || err);
                    await mergeInto(p.id, p.data);
                }
            }
            return { profile_id: primary.id, created: false };
        } catch (err: any) {
            // Caching must never fail the caller — log and move on.
            console.error("[recordProfile] failed to cache profile:", err?.message || err);
            return { profile_id: null, created: false };
        }
    }
};
