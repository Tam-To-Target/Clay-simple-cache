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
     *  - Resolves by ANY provided key (email → linkedin → phone), so a contact
     *    that shares a key with an existing profile updates it instead of
     *    colliding on the unique constraint.
     *  - Only FILLS missing identity columns (never overwrites an existing one),
     *    which avoids touching keys owned by other profiles.
     *  - Catches unique-constraint races/edge cases and degrades to a data-only
     *    merge (or a no-op) rather than throwing.
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

        // A profile needs at least one identity key; nothing to cache otherwise.
        if (!keys.email && !keys.phone_e164 && !keys.linkedin_url && !keys.linkedin_slug) {
            return { profile_id: null, created: false };
        }

        try {
            const { profile } = await this.findProfile(keys);

            if (profile) {
                const updates: any = { data: this.mergeData(profile.data, data) };
                // Fill ONLY missing identity columns — never overwrite one that's
                // set (it may be owned by this or, on conflict, another profile).
                if (keys.email && !profile.email) updates.email = keys.email;
                if (keys.linkedin_slug && !profile.linkedin_slug) updates.linkedin_slug = keys.linkedin_slug;
                if (keys.linkedin_url && !profile.linkedin_url) updates.linkedin_url = keys.linkedin_url;
                if (keys.phone_e164 && !profile.phone_e164) updates.phone_e164 = keys.phone_e164;

                try {
                    await this.updateProfile(profile.id, updates);
                } catch {
                    // A filled key collided with another profile — keep the merge.
                    await this.updateProfile(profile.id, { data: updates.data } as any);
                }
                return { profile_id: profile.id, created: false };
            }

            const created = await this.createProfile({ ...keys, data: data as Prisma.InputJsonValue });
            return { profile_id: created.id, created: true };
        } catch {
            // Lost a create race (or a key is owned elsewhere): re-resolve and
            // merge data into whatever now exists; give up quietly if not.
            try {
                const { profile } = await this.findProfile(keys);
                if (profile) {
                    await this.updateProfile(profile.id, { data: this.mergeData(profile.data, data) } as any);
                    return { profile_id: profile.id, created: false };
                }
            } catch { /* swallow — caching must not fail the caller */ }
            return { profile_id: null, created: false };
        }
    }
};
